import { EventEmitter } from "node:events";
import type { LoopMode, PlayerState, Track } from "./types.js";

export class PlayerManager extends EventEmitter {
  private readonly players = new Map<string, PlayerState>();
  get(guildId: string): PlayerState {
    let state = this.players.get(guildId);
    if (!state) { state = { guildId, queue: [], history: [], index: 0, paused: false, position: 0, loop: "off", playbackRevision: 0 }; this.players.set(guildId, state); }
    return state;
  }
  snapshot(guildId: string) { return structuredClone(this.get(guildId)); }
  add(guildId: string, tracks: Track[], next = false) {
    const s = this.get(guildId); const at = next ? Math.min(s.index + 1, s.queue.length) : s.queue.length;
    s.queue.splice(at, 0, ...tracks); this.changed(s); return s;
  }
  playIndex(guildId: string, index: number) { const s = this.get(guildId); if (index < 0 || index >= s.queue.length) return; s.index = index; s.position = 0; s.paused = false; s.playbackRevision++; this.changed(s); }
  skip(guildId: string) { const s = this.get(guildId); if (s.queue[s.index]) s.history.push(s.queue[s.index]); if (s.loop !== "song") s.index = Math.min(s.index + 1, s.queue.length); if (s.loop === "playlist" && s.index >= s.queue.length) s.index = 0; s.position = 0; s.playbackRevision++; this.changed(s); }
  previous(guildId: string) { const s = this.get(guildId); s.index = Math.max(0, s.index - 1); s.position = 0; s.playbackRevision++; this.changed(s); }
  rewind(guildId: string) { const s = this.get(guildId); s.position = 0; s.playbackRevision++; this.changed(s); }
  setLoop(guildId: string, loop: LoopMode) { const s = this.get(guildId); s.loop = loop; this.changed(s); }
  pause(guildId: string) { const s = this.get(guildId); s.paused = !s.paused; this.changed(s); }
  setVoiceChannel(guildId: string, channelId: string) { const s = this.get(guildId); s.voiceChannelId = channelId; s.paused = false; this.changed(s); }
  stop(guildId: string, clear = false) { const s = this.get(guildId); s.paused = true; s.voiceChannelId = undefined; s.position = 0; s.playbackRevision++; if (clear) { s.queue = []; s.index = 0; } this.changed(s); }
  private changed(s: PlayerState) { this.emit("change", structuredClone(s)); }
}
