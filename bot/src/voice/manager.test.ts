import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PlayerManager } from "../player.js";
import type { AudioSource, PlaybackEvent, VoiceTransport } from "./types.js";
import { PlaybackCoordinator } from "./manager.js";

class FakeVoice implements VoiceTransport {
  calls: string[] = []; channels = new Map<string, string>(); events = new EventEmitter(); sources = new Map<string, { source: AudioSource; generation: number }>();
  async connect(g: string, c: string) { this.calls.push(`connect:${g}:${c}`); this.channels.set(g, c); }
  async disconnect(g: string) { this.calls.push(`disconnect:${g}`); this.channels.delete(g); }
  async play(g: string, source: AudioSource, generation: number) { this.calls.push(`play:${g}:${source.track.id}`); this.sources.set(g, { source, generation }); }
  async pause(g: string) { this.calls.push(`pause:${g}`); }
  async resume(g: string) { this.calls.push(`resume:${g}`); }
  async stop(g: string) { this.calls.push(`stop:${g}`); }
  async seek() {}
  isConnected(g: string) { return this.channels.has(g); }
  channelId(g: string) { return this.channels.get(g); }
  onPlayback(listener: (event: PlaybackEvent) => void) { this.events.on("p", listener); return () => this.events.off("p", listener); }
  end(g: string, type: "ended" | "error" = "ended", generation = this.sources.get(g)!.generation) { this.events.emit("p", { guildId: g, generation, type }); }
  async shutdown() { for (const g of [...this.channels.keys()]) await this.disconnect(g); }
}
const track = (id: string) => ({ id, title: id, artist: "artist", url: `https://media.example/${id}.mp3`, duration: 10 });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("coordinator connects once and controls real per-guild playback", async () => {
  const players = new PlayerManager(), voice = new FakeVoice(); const coordinator = new PlaybackCoordinator(players, voice);
  players.setVoiceChannel("g", "vc"); players.add("g", [track("one")]); await settle();
  players.add("g", [track("two")]); await settle();
  assert.equal(voice.calls.filter(x => x.startsWith("connect:")).length, 1);
  players.pause("g"); await settle(); players.pause("g"); await settle();
  assert.ok(voice.calls.includes("pause:g")); assert.ok(voice.calls.includes("resume:g"));
  const oldGeneration = voice.sources.get("g")!.generation; players.skip("g"); await settle();
  assert.equal(voice.sources.get("g")!.source.track.id, "two");
  voice.end("g", "ended", oldGeneration); await settle(); assert.equal(players.get("g").index, 1, "stale EOF must not advance");
  players.rewind("g"); await settle(); assert.equal(voice.calls.filter(x => x === "play:g:two").length, 2);
  players.stop("g"); await settle(); assert.equal(voice.isConnected("g"), false);
  await coordinator.shutdown();
});

test("natural EOF advances exactly once and honors both loop modes", async () => {
  const players = new PlayerManager(), voice = new FakeVoice(); new PlaybackCoordinator(players, voice);
  players.setVoiceChannel("g", "vc"); players.add("g", [track("one"), track("two")]); await settle();
  voice.end("g"); await settle(); assert.equal(players.get("g").index, 1);
  players.setLoop("g", "playlist"); voice.end("g"); await settle(); assert.equal(players.get("g").index, 0);
  players.setLoop("g", "song"); voice.end("g"); await settle(); assert.equal(players.get("g").index, 0); assert.equal(voice.sources.get("g")!.source.track.id, "one");
});

test("guild voice sessions are independent and shutdown cleans both", async () => {
  const players = new PlayerManager(), voice = new FakeVoice(); const coordinator = new PlaybackCoordinator(players, voice);
  for (const g of ["a", "b"]) { players.setVoiceChannel(g, `vc-${g}`); players.add(g, [track(g)]); }
  await settle(); assert.deepEqual([...voice.channels.keys()].sort(), ["a", "b"]);
  await coordinator.shutdown(); assert.equal(voice.channels.size, 0);
});
