import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdapter } from "../adapterFactory.js";
import { FluxerAdapter, StoatAdapter } from "../platform.js";
import { MultiPlatformAdapter } from "./multi.js";
import type { CommandContext, PlatformAdapter } from "../types.js";
import type { AudioSource, PlaybackEvent, VoiceTransport } from "../voice/types.js";

class FakeTransport implements VoiceTransport {
  calls: string[] = []; listeners: Array<(event: PlaybackEvent) => void> = []; shut = false;
  async connect(guildId: string, channelId: string) { this.calls.push(`connect ${guildId} ${channelId}`); }
  async disconnect(guildId: string) { this.calls.push(`disconnect ${guildId}`); }
  async play(guildId: string, _source: AudioSource, generation: number) { this.calls.push(`play ${guildId} ${generation}`); }
  async pause(guildId: string) { this.calls.push(`pause ${guildId}`); }
  async resume(guildId: string) { this.calls.push(`resume ${guildId}`); }
  async stop(guildId: string) { this.calls.push(`stop ${guildId}`); }
  async seek(guildId: string, position: number, generation: number) { this.calls.push(`seek ${guildId} ${position} ${generation}`); }
  isConnected(guildId: string) { return guildId === "connected"; }
  channelId(guildId: string) { return guildId === "connected" ? "voice" : undefined; }
  onPlayback(listener: (event: PlaybackEvent) => void) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter(x => x !== listener); }; }
  async shutdown() { this.shut = true; }
}
class FakeAdapter implements PlatformAdapter {
  readonly voice = new FakeTransport(); handler?: (ctx: CommandContext, content: string) => Promise<void>; stopped = false;
  async start(onMessage: (ctx: CommandContext, content: string) => Promise<void>) { this.handler = onMessage; }
  async stop() { this.stopped = true; }
  send(guildId: string, content: string) { return this.handler!({ guildId, channelId: "text", userId: "user", voiceChannelId: "voice", reply: async () => {} }, content); }
}

test("ARIA_PLATFORM=both needs both tokens and builds both adapters", () => {
  assert.throws(() => createAdapter({ ARIA_PLATFORM: "both" }), /ARIA_FLUXER_TOKEN and ARIA_STOAT_TOKEN are required/);
  assert.throws(() => createAdapter({ ARIA_PLATFORM: "Both", ARIA_FLUXER_TOKEN: "f" }), /ARIA_STOAT_TOKEN is required/);
  const adapter = createAdapter({ ARIA_PLATFORM: "both", ARIA_FLUXER_TOKEN: "f", ARIA_STOAT_TOKEN: "s" });
  assert.ok(adapter instanceof MultiPlatformAdapter); assert.ok(adapter.voice);
  assert.ok(createAdapter({ ARIA_PLATFORM: "fluxer", ARIA_FLUXER_TOKEN: "f" }) instanceof FluxerAdapter);
  assert.ok(createAdapter({ ARIA_PLATFORM: "stoat", ARIA_STOAT_TOKEN: "s" }) instanceof StoatAdapter);
});

test("messages are scoped per platform so the same guild id never collides", async () => {
  const fluxer = new FakeAdapter(), stoat = new FakeAdapter(); const seen: string[] = [];
  const multi = new MultiPlatformAdapter([{ name: "fluxer", adapter: fluxer }, { name: "stoat", adapter: stoat }]);
  await multi.start(async ctx => { seen.push(ctx.guildId); });
  await fluxer.send("123", "a!help"); await stoat.send("123", "a!help");
  assert.deepEqual(seen, ["fluxer:123", "stoat:123"]);
  await multi.stop(); assert.ok(fluxer.stopped && stoat.stopped);
});

test("voice calls route to the right platform with the original guild id", async () => {
  const fluxer = new FakeAdapter(), stoat = new FakeAdapter();
  const multi = new MultiPlatformAdapter([{ name: "fluxer", adapter: fluxer }, { name: "stoat", adapter: stoat }]); const voice = multi.voice!;
  await voice.connect("stoat:g1", "vc"); await voice.play("fluxer:g2", { track: { id: "t", title: "t", url: "u", artist: "a", duration: 1 }, inputUrl: "u" }, 3);
  assert.deepEqual(stoat.voice.calls, ["connect g1 vc"]); assert.deepEqual(fluxer.voice.calls, ["play g2 3"]);
  assert.equal(voice.isConnected("fluxer:connected"), true); assert.equal(voice.channelId("stoat:connected"), "voice");
  assert.throws(() => voice.isConnected("unknown:g"), /No voice transport/);
  const events: PlaybackEvent[] = []; const off = voice.onPlayback(event => events.push(event));
  stoat.voice.listeners[0]({ guildId: "g1", generation: 1, type: "ended" });
  assert.deepEqual(events, [{ guildId: "stoat:g1", generation: 1, type: "ended" }]);
  off(); assert.equal(stoat.voice.listeners.length, 0); assert.equal(fluxer.voice.listeners.length, 0);
  await voice.shutdown(); assert.ok(fluxer.voice.shut && stoat.voice.shut);
});
