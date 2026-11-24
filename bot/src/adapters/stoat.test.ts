import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { StoatAdapter, parseVoiceStates } from "./stoat.js";
import { voiceNodeNames, StoatVoiceTransport } from "../voice/stoat.js";
import { CommandRouter } from "../commands.js";
import type { CommandContext } from "../types.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN; sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close(code = 1000, reason = "") { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit("close", code, Buffer.from(reason)); }
}
const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const quiet = () => { const log = console.log, warn = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = log; console.warn = warn; }; };
const ready = (voice_states?: unknown[]) => ({ type: "Ready", users: [{ _id: "self", relationship: "User" }], channels: [{ _id: "text", server: "server" }, { _id: "vc-1", server: "server" }, { _id: "vc-2", server: "server" }], ...(voice_states ? { voice_states } : {}) });
const participant = (id: string) => ({ id, joined_at: 0, is_receiving: true, is_publishing: true, screensharing: false, camera: false });

async function setup(options: { checkSockets?: FakeSocket[] } = {}) {
  const main = new FakeSocket(); const sockets: FakeSocket[] = [];
  const contexts: CommandContext[] = [];
  const adapter = new StoatAdapter("secret", async () => ok(), () => { const s = sockets.length === 0 ? main : options.checkSockets?.shift() ?? new FakeSocket(); sockets.push(s); return s as never; }, { voiceCheckTimeoutMs: 50 });
  await adapter.start(async ctx => { contexts.push(ctx); }); main.emit("open");
  const send = async (content = "a!help") => { adapter.handleEvent({ type: "Message", channel: "text", author: "nest", content }); await new Promise(resolve => setImmediate(resolve)); return contexts.at(-1)!; };
  return { adapter, main, sockets, contexts, send };
}

test("parseVoiceStates reads Stoat's channel voice states", () => {
  assert.deepEqual(parseVoiceStates([{ id: "vc-1", participants: [participant("a"), participant("b")] }, { id: "vc-2", participants: [] }, { nope: true }]), [["a", "vc-1"], ["b", "vc-1"]]);
});

test("Stoat tracks joins, moves and leaves", async () => {
  const restore = quiet(); try {
    const { adapter, send } = await setup();
    adapter.handleEvent(ready([]));
    adapter.handleEvent({ type: "VoiceChannelJoin", id: "vc-1", state: participant("nest") });
    assert.equal((await send()).voiceChannelId, "vc-1");
    adapter.handleEvent({ type: "VoiceChannelMove", user: "nest", from: "vc-1", to: "vc-2", state: participant("nest") });
    assert.equal((await send()).voiceChannelId, "vc-2");
    adapter.handleEvent({ type: "VoiceChannelLeave", id: "vc-2", user: "nest" });
    assert.equal((await send()).voiceChannelId, undefined);
    await adapter.stop();
  } finally { restore(); }
});

test("a late leave from another channel does not undo a newer join", async () => {
  const restore = quiet(); try {
    const { adapter, send } = await setup();
    adapter.handleEvent(ready([]));
    adapter.handleEvent({ type: "VoiceChannelJoin", id: "vc-2", state: participant("nest") });
    adapter.handleEvent({ type: "VoiceChannelLeave", id: "vc-1", user: "nest" });
    assert.equal((await send()).voiceChannelId, "vc-2");
    await adapter.stop();
  } finally { restore(); }
});

test("Ready replaces the voice list, inside Bulk too", async () => {
  const restore = quiet(); try {
    const { adapter, send } = await setup();
    adapter.handleEvent(ready([{ id: "vc-1", participants: [participant("nest")] }]));
    assert.equal((await send()).voiceChannelId, "vc-1");
    // Nest left while Aria was reconnecting: the next Ready no longer lists them.
    adapter.handleEvent({ type: "Bulk", v: [ready([{ id: "vc-2", participants: [participant("someone")] }])] });
    assert.equal((await send()).voiceChannelId, undefined);
    // A Ready without a voice list keeps what Aria knew.
    adapter.handleEvent({ type: "VoiceChannelJoin", id: "vc-2", state: participant("nest") });
    adapter.handleEvent(ready());
    assert.equal((await send()).voiceChannelId, "vc-2");
    await adapter.stop();
  } finally { restore(); }
});

test("ServerCreate adds the new server's channels and voice states", async () => {
  const restore = quiet(); try {
    const { adapter, contexts } = await setup();
    adapter.handleEvent(ready([]));
    adapter.handleEvent({ type: "ServerCreate", id: "server-2", server: { _id: "server-2" }, channels: [{ _id: "text-2", server: "server-2" }], emojis: [], voice_states: [{ id: "vc-9", participants: [participant("nest")] }] });
    adapter.handleEvent({ type: "Message", channel: "text-2", author: "nest", content: "a!help" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(contexts.at(-1)?.guildId, "server-2"); assert.equal(contexts.at(-1)?.voiceChannelId, "vc-9");
    await adapter.stop();
  } finally { restore(); }
});

test("events from a replaced connection are ignored", async () => {
  const restore = quiet(); try {
    const { adapter, main, send } = await setup();
    adapter.handleEvent(ready([]));
    main.close(1006);
    // The old socket is gone; a stray message on it must not change anything.
    main.emit("message", Buffer.from(JSON.stringify({ type: "VoiceChannelJoin", id: "vc-1", state: participant("nest") })));
    assert.equal((await send()).voiceChannelId, undefined);
    await adapter.stop();
  } finally { restore(); }
});

test("a missed join is found by asking Stoat directly", async () => {
  const restore = quiet(); try {
    const check = new FakeSocket();
    const { adapter, sockets, send } = await setup({ checkSockets: [check] });
    adapter.handleEvent(ready([]));
    const ctx = await send();
    assert.equal(ctx.voiceChannelId, undefined);
    const pending = ctx.findVoiceChannel!();
    assert.equal(sockets.length, 2, "opens a second, short connection");
    check.emit("open");
    assert.deepEqual(JSON.parse(check.sent[0]), { type: "Authenticate", token: "secret" });
    check.emit("message", Buffer.from(JSON.stringify({ type: "Authenticated" })));
    check.emit("message", Buffer.from(JSON.stringify(ready([{ id: "vc-1", participants: [participant("nest")] }]))));
    assert.equal(await pending, "vc-1");
    assert.equal(check.readyState, WebSocket.CLOSED, "closes the check connection");
    assert.equal(sockets[0].readyState, WebSocket.OPEN, "leaves the main connection alone");
    assert.equal((await send()).voiceChannelId, "vc-1", "remembers the result");
    await adapter.stop();
  } finally { restore(); }
});

test("the direct check gives up quietly when Stoat does not answer", async () => {
  const restore = quiet(); try {
    const check = new FakeSocket();
    const { adapter, send } = await setup({ checkSockets: [check] });
    adapter.handleEvent(ready([]));
    assert.equal(await (await send()).findVoiceChannel!(), undefined);
    assert.equal(check.readyState, WebSocket.CLOSED);
    await adapter.stop();
  } finally { restore(); }
});

test("play uses the direct check before saying to join a voice channel", async () => {
  const replies: string[] = []; let checked = 0;
  const players = { get: () => ({ voiceChannelId: undefined }), setVoiceChannel: (_g: string, c: string) => replies.push(`voice:${c}`), add: () => {} };
  const search = { sources: {}, search: async () => [{ id: "t", title: "Song", url: "u", artist: "a", duration: 1 }] };
  const settings = { get: () => ({ prefix: "a!", defaultResults: 10, queuePageSize: 10 }) };
  const router = new CommandRouter(settings as never, players as never, search as never);
  const base = { guildId: "g", channelId: "c", userId: "u", reply: async (m: string) => { replies.push(m); } };
  await router.handle({ ...base, findVoiceChannel: async () => { checked++; return "vc-1"; } }, "a!play song");
  assert.equal(checked, 1); assert.deepEqual(replies, ["voice:vc-1", "Queued: **Song**."]);
  replies.length = 0;
  await router.handle({ ...base, findVoiceChannel: async () => undefined }, "a!play song");
  assert.deepEqual(replies, ["Join a voice channel first."]);
});

test("Stoat voice uses a node from Stoat's own list", async () => {
  assert.deepEqual(voiceNodeNames({ features: { livekit: { enabled: true, nodes: [{ name: "hel1", public_url: "wss://x" }, { name: "" }, {}] } } }), ["hel1"]);
  assert.deepEqual(voiceNodeNames({}), []);
  const bodies: unknown[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (String(url) === "https://api.stoat.chat/") return new Response(JSON.stringify({ features: { livekit: { nodes: [{ name: "hel1" }] } } }), { status: 200 });
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ token: "t", url: "wss://lk" }), { status: 200 });
  }) as typeof fetch;
  const transport = new StoatVoiceTransport("secret", fetcher) as unknown as { credentials(g: string, c: string): Promise<{ token: string; endpoint: string }> };
  assert.deepEqual(await transport.credentials("g", "vc-1"), { token: "t", endpoint: "wss://lk" });
  assert.deepEqual(bodies, [{ node: "hel1" }]);
});
