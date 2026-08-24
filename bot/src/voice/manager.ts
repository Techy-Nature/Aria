import type { PlayerState } from "../types.js";
import { PlayerManager } from "../player.js";
import type { PlaybackEvent, VoiceTransport } from "./types.js";
import { PlaybackFeedback } from "./feedback.js";
import { DirectMediaResolver, type PlayableSourceResolver } from "./source.js";
import { ProviderUnavailableError, UnplayableSourceError } from "../sources/types.js";

interface Observed { revision: number; trackId?: string; paused: boolean; generation: number; busy: Promise<void> }
export class PlaybackCoordinator {
  private readonly observed = new Map<string, Observed>(); private readonly unsubscribe: () => void;
  constructor(private readonly players: PlayerManager, private readonly transport: VoiceTransport, private readonly feedback?: PlaybackFeedback, private readonly sources: PlayableSourceResolver = new DirectMediaResolver()) {
    this.players.on("change", (state: PlayerState) => this.enqueue(state));
    this.unsubscribe = transport.onPlayback(event => this.ended(event));
  }
  private enqueue(state: PlayerState) {
    const current = this.observed.get(state.guildId) ?? { revision: -1, paused: false, generation: 0, busy: Promise.resolve() };
    current.busy = current.busy.then(() => this.reconcile(state, current)).catch(error => {
      console.error(`[Voice] ${error instanceof Error ? error.message : String(error)}`);
      const message = error instanceof UnplayableSourceError || error instanceof ProviderUnavailableError ? error.message : "I couldn't connect to or play in that voice channel.";
      void this.feedback?.report(state.guildId, message);
    });
    this.observed.set(state.guildId, current);
  }
  private async reconcile(state: PlayerState, seen: Observed) {
    if (!state.voiceChannelId) { seen.generation++; await this.transport.stop(state.guildId); await this.transport.disconnect(state.guildId); seen.trackId = undefined; seen.revision = state.playbackRevision; seen.paused = state.paused; return; }
    const track = state.queue[state.index]; if (!track) { await this.transport.stop(state.guildId); seen.trackId = undefined; return; }
    const connectedChannel = this.transport.channelId(state.guildId);
    if (connectedChannel && connectedChannel !== state.voiceChannelId) throw new Error("User must join Aria's current voice channel.");
    if (!this.transport.isConnected(state.guildId)) await this.transport.connect(state.guildId, state.voiceChannelId);
    if (seen.trackId !== track.id || seen.revision !== state.playbackRevision) { const generation = ++seen.generation; await this.transport.play(state.guildId, await this.sources.resolve(track, state.position), generation); seen.trackId = track.id; seen.revision = state.playbackRevision; seen.paused = false; }
    if (state.paused !== seen.paused) { await (state.paused ? this.transport.pause(state.guildId) : this.transport.resume(state.guildId)); seen.paused = state.paused; }
  }
  private ended(event: PlaybackEvent) { const seen = this.observed.get(event.guildId); if (!seen || event.generation !== seen.generation) return; if (event.type === "error") { console.error(`[Voice] Playback failed: ${event.error?.message ?? "unknown decoder error"}`); void this.feedback?.report(event.guildId, "Playback failed while decoding the media."); } else console.log("[Voice] Track ended"); this.players.skip(event.guildId); }
  async shutdown() { this.unsubscribe(); await this.transport.shutdown(); }
}
