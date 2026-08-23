import { EventEmitter } from "node:events";
import { AudioSource as LiveKitAudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { decodeToLiveKit, type Decoder } from "./audio.js";
import type { AudioSource, PlaybackEvent, VoiceTransport } from "./types.js";

export interface VoiceCredentials { endpoint: string; token: string }
interface Session { channelId: string; room: Room; sink: LiveKitAudioSource; track: LocalAudioTrack; decoder?: Decoder; generation: number; manualGeneration: number }

export abstract class LiveKitVoiceTransport implements VoiceTransport {
  protected readonly sessions = new Map<string, Session>();
  private readonly events = new EventEmitter();
  protected abstract credentials(guildId: string, channelId: string): Promise<VoiceCredentials>;
  protected async leaveSignaling(_guildId: string): Promise<void> {}
  protected abstract readonly label: string;

  async connect(guildId: string, channelId: string) {
    const existing = this.sessions.get(guildId);
    if (existing?.channelId === channelId && existing.room.isConnected) return;
    if (existing) throw new Error("Aria is already connected to another voice channel.");
    console.log(`[Voice/${this.label}] Joining guild ${guildId} channel ${channelId}`);
    const { endpoint, token } = await this.credentials(guildId, channelId);
    console.log(`[Voice/${this.label}] Voice server assigned`);
    const room = new Room();
    await room.connect(endpoint, token, { autoSubscribe: false, dynacast: false });
    const sink = new LiveKitAudioSource(48000, 2);
    const track = LocalAudioTrack.createAudioTrack("aria-audio", sink);
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    if (!room.localParticipant) throw new Error("LiveKit connected without a local participant.");
    await room.localParticipant.publishTrack(track, options);
    this.sessions.set(guildId, { channelId, room, sink, track, generation: 0, manualGeneration: -1 });
    console.log(`[Voice/${this.label}] LiveKit connected`);
  }
  async play(guildId: string, source: AudioSource, generation: number) {
    const session = this.require(guildId); this.stopDecoder(session); session.generation = generation;
    console.log(`[Voice] Starting: ${source.track.title}`);
    const decoder = await decodeToLiveKit(source, session.sink); session.decoder = decoder;
    void decoder.done.then(() => this.finish(guildId, generation, "ended"), error => this.finish(guildId, generation, "error", error));
  }
  async pause(guildId: string) { this.require(guildId).decoder?.pause(); console.log("[Voice] Paused"); }
  async resume(guildId: string) { this.require(guildId).decoder?.resume(); console.log("[Voice] Resumed"); }
  async stop(guildId: string) { const s = this.sessions.get(guildId); if (s) this.stopDecoder(s); }
  async seek(guildId: string, positionSeconds: number, generation: number) { throw new Error(`seek must be coordinated as a new play (${positionSeconds}, ${generation})`); }
  async disconnect(guildId: string) { const s = this.sessions.get(guildId); if (!s) return; this.stopDecoder(s); this.sessions.delete(guildId); await s.room.disconnect(); await this.leaveSignaling(guildId); console.log("[Voice] Disconnected"); }
  isConnected(guildId: string) { return this.sessions.get(guildId)?.room.isConnected ?? false; }
  channelId(guildId: string) { return this.sessions.get(guildId)?.channelId; }
  onPlayback(listener: (event: PlaybackEvent) => void) { this.events.on("playback", listener); return () => this.events.off("playback", listener); }
  async shutdown() { await Promise.all([...this.sessions.keys()].map(id => this.disconnect(id))); }
  private require(guildId: string) { const session = this.sessions.get(guildId); if (!session) throw new Error("Voice is not connected."); return session; }
  private stopDecoder(session: Session) { if (!session.decoder) return; session.manualGeneration = session.generation; session.decoder.stop(); session.decoder = undefined; }
  private finish(guildId: string, generation: number, type: "ended" | "error", error?: Error) { const s = this.sessions.get(guildId); if (!s || s.generation !== generation || s.manualGeneration === generation) return; s.decoder = undefined; this.events.emit("playback", { guildId, generation, type, error } satisfies PlaybackEvent); }
}
