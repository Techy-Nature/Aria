import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { createAdapter } from "./adapterFactory.js";
import { FluxerAdapter, StoatAdapter, ConsoleAdapter } from "./platform.js";
import type { CommandContext } from "./types.js";

class FakeSocket extends EventEmitter { readyState: number = WebSocket.OPEN; sent: string[] = []; send(value: string) { this.sent.push(value); } close(code = 1000, reason = "") { this.readyState = WebSocket.CLOSED; this.emit("close", code, Buffer.from(reason)); } }
const response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

test("adapter selection and required token", async () => {
  const consoleAdapter = createAdapter({ ARIA_PLATFORM: "console" }); assert.ok(consoleAdapter instanceof ConsoleAdapter); await consoleAdapter.stop();
  assert.ok(createAdapter({ ARIA_PLATFORM: "FLUXER", ARIA_TOKEN: "x" }) instanceof FluxerAdapter);
  assert.ok(createAdapter({ ARIA_PLATFORM: "stoat", ARIA_TOKEN: "x" }) instanceof StoatAdapter);
  assert.throws(() => createAdapter({ ARIA_PLATFORM: "fluxer" }), /ARIA_TOKEN is required/);
  assert.throws(() => createAdapter({ ARIA_PLATFORM: "stoat" }), /ARIA_TOKEN is required/);
});

test("Fluxer normalizes messages, ignores bots, and replies to source channel", async () => {
  const requests: Array<[string, RequestInit | undefined]> = []; const socket = new FakeSocket(); const contexts: CommandContext[] = [];
  const adapter = new FluxerAdapter("secret", async (url, init) => { requests.push([String(url), init]); return response(); }, () => socket as never);
  await adapter.start(async ctx => { contexts.push(ctx); });
  adapter.handleGatewayEvent({ op: 0, t: "READY", d: { session_id: "s", user: { id: "self", username: "Aria" } } });
  adapter.handleGatewayEvent({ op: 0, t: "MESSAGE_CREATE", d: { guild_id: "g", channel_id: "c", content: "a!help", author: { id: "u" } } });
  adapter.handleGatewayEvent({ op: 0, t: "MESSAGE_CREATE", d: { guild_id: "g", channel_id: "c", content: "loop", author: { id: "self" } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(contexts.length, 1); assert.deepEqual({ guildId: contexts[0].guildId, channelId: contexts[0].channelId, userId: contexts[0].userId }, { guildId: "g", channelId: "c", userId: "u" });
  await contexts[0].reply("answer"); assert.equal(requests[0][0], "https://api.fluxer.app/v1/channels/c/messages"); assert.equal((requests[0][1]?.headers as Record<string,string>).Authorization, "Bot secret"); await adapter.stop();
});

test("Fluxer hydrates guild voice states and tracks moves and leaves", async () => {
  const contexts: CommandContext[] = []; const socket = new FakeSocket();
  const adapter = new FluxerAdapter("secret", fetch, () => socket as never);
  await adapter.start(async ctx => { contexts.push(ctx); });
  adapter.handleGatewayEvent({ op: 0, t: "READY", d: { session_id: "s", user: { id: "self" } } });
  adapter.handleGatewayEvent({ op: 0, t: "GUILD_CREATE", d: { id: "guild", voice_states: [{ user_id: "listener", channel_id: "voice-1", connection_id: "connection" }] } });

  const message = { op: 0, t: "MESSAGE_CREATE", d: { guild_id: "guild", channel_id: "text", content: "a!play song", author: { id: "listener" } } };
  adapter.handleGatewayEvent(message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contexts.at(-1)?.voiceChannelId, "voice-1");

  adapter.handleGatewayEvent({ op: 0, t: "VOICE_STATE_UPDATE", d: { guild_id: "guild", user_id: "listener", channel_id: "voice-2" } });
  adapter.handleGatewayEvent(message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contexts.at(-1)?.voiceChannelId, "voice-2");

  adapter.handleGatewayEvent({ op: 0, t: "VOICE_STATE_UPDATE", d: { guild_id: "guild", user_id: "listener", channel_id: null } });
  adapter.handleGatewayEvent(message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contexts.at(-1)?.voiceChannelId, undefined);
  await adapter.stop();
});

test("Fluxer rebuilds stale guild voice state on GUILD_CREATE and fresh READY", async () => {
  const contexts: CommandContext[] = []; const socket = new FakeSocket();
  const adapter = new FluxerAdapter("secret", fetch, () => socket as never);
  await adapter.start(async ctx => { contexts.push(ctx); });
  adapter.handleGatewayEvent({ op: 0, t: "READY", d: { session_id: "first", user: { id: "self" } } });
  adapter.handleGatewayEvent({ op: 0, t: "GUILD_CREATE", d: { id: "guild", voice_states: [{ user_id: "listener", channel_id: "stale" }] } });
  adapter.handleGatewayEvent({ op: 0, t: "GUILD_CREATE", d: { id: "guild", voice_states: [] } });
  adapter.handleGatewayEvent({ op: 0, t: "VOICE_STATE_UPDATE", d: { guild_id: "guild", user_id: "listener", channel_id: "also-stale" } });
  adapter.handleGatewayEvent({ op: 0, t: "READY", d: { session_id: "fresh", user: { id: "self" } } });
  adapter.handleGatewayEvent({ op: 0, t: "MESSAGE_CREATE", d: { guild_id: "guild", channel_id: "text", content: "a!play song", author: { id: "listener" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contexts[0].voiceChannelId, undefined);
  await adapter.stop();
});

test("Stoat normalizes server messages, ignores self, and replies to source channel", async () => {
  const requests: string[] = []; const socket = new FakeSocket(); const contexts: CommandContext[] = [];
  const adapter = new StoatAdapter("secret", async url => { requests.push(String(url)); return response(); }, () => socket as never); await adapter.start(async ctx => { contexts.push(ctx); }); socket.emit("open");
  // Current Stoat Ready users use RelationshipStatus "User" for the authenticated
  // session user, including bot sessions; other users have another relationship.
  adapter.handleEvent({ type: "Ready", users: [
    { _id: "friend", username: "Listener", discriminator: "0001", relationship: "Friend", online: true },
    { _id: "self", username: "Aria", discriminator: "0002", relationship: "User", online: true, bot: { owner: "owner" } },
  ], channels: [{ _id: "c", channel_type: "TextChannel", server: "g", name: "music" }] });
  adapter.handleEvent({ type: "Bulk", v: [{ type: "Message", channel: "c", author: "u", content: "a!help" }, { type: "Message", channel: "c", author: "self", content: "ignore" }] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(contexts.length, 1); assert.equal(contexts[0].guildId, "g"); await contexts[0].reply("answer"); assert.equal(requests[0], "https://api.stoat.chat/channels/c/messages"); await adapter.stop();
});

test("stop prevents reconnect", async () => {
  let created = 0; const socket = new FakeSocket(); const adapter = new FluxerAdapter("secret", fetch, () => { created++; return socket as never; }); await adapter.start(async () => {}); socket.close(1006); await adapter.stop(); await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(created, 1);
});
