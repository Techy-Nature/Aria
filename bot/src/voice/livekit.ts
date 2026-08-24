import { EventEmitter } from "node:events";
import { AudioSource as LiveKitAudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { decodeToLiveKit, type Decoder } from "./audio.js";
import type { AudioSource, PlaybackEvent, VoiceTransport } from "./types.js";

export interface VoiceCredentials { endpoint: string; token: string }
interface Session { channelId: string; room: Room; sink: LiveKitAudioSource; track: LocalAudioTrack; decoder?: Decoder; generation: number; manualGeneration: number }
interface ConnectionAttempt { channelId: string; promise: Promise<void>; cancelled: boolean }

export abstract class LiveKitVoiceTransport implements VoiceTransport {
  protected readonly sessions = new Map<string, Session>();
  private readonly connections = new Map<string, ConnectionAttempt>();
  private readonly events = new EventEmitter();
  protected abstract credentials(guildId: string, channelId: string): Promise<VoiceCredentials>;
  protected async leaveSignaling(_guildId: string): Promise<void> {}
  protected abstract readonly label: string;

  async connect(guildId: string, channelId: string) {
    const existing = this.sessions.get(guildId);
    if (existing?.channelId === channelId && existing.room.isConnected) return;
    if (existing) throw new Error("Aria is already connected to another voice channel.");
    const pending = this.connections.get(guildId);
    if (pending) {
      if (pending.channelId !== channelId) throw new Error("Aria is already connected to another voice channel.");
      return pending.promise;
    }
    const attempt: ConnectionAttempt = { channelId, cancelled: false, promise: Promise.resolve() };
    attempt.promise = this.establish(guildId, channelId, attempt).finally(() => {
      if (this.connections.get(guildId) === attempt) this.connections.delete(guildId);
    });
    this.connections.set(guildId, attempt);
    return attempt.promise;
  }
  private async establish(guildId: string, channelId: string, attempt: ConnectionAttempt) {
    console.log(`[Voice/${this.label}] Joining guild ${guildId} channel ${channelId}`);
    let room: Room | undefined; let signalingStarted = false;
    try {
      const { endpoint, token } = await this.credentials(guildId, channelId); signalingStarted = true;
      this.ensureActive(attempt);
      console.log(`[Voice/${this.label}] Voice server assigned`);
      room = this.createRoom();
      await room.connect(endpoint, token, { autoSubscribe: false, dynacast: false });
      this.ensureActive(attempt);
      const sink = this.createAudioSource();
      const track = this.createAudioTrack(sink);
      const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
      if (!room.localParticipant) throw new Error("LiveKit connected without a local participant.");
      await room.localParticipant.publishTrack(track, options);
      this.ensureActive(attempt);
      this.sessions.set(guildId, { channelId, room, sink, track, generation: 0, manualGeneration: -1 });
      console.log(`[Voice/${this.label}] LiveKit connected`);
    } catch (error) {
      await room?.disconnect().catch(() => {});
      if (signalingStarted) await this.leaveSignaling(guildId).catch(() => {});
      throw error;
    }
  }
  protected createRoom(): Room { return new Room(); }
  protected createAudioSource(): LiveKitAudioSource { return new LiveKitAudioSource(48000, 2); }
  protected createAudioTrack(sink: LiveKitAudioSource): LocalAudioTrack { return LocalAudioTrack.createAudioTrack("aria-audio", sink); }
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
  async disconnect(guildId: string) { const pending = this.connections.get(guildId); if (pending) { pending.cancelled = true; await pending.promise.catch(() => {}); } const s = this.sessions.get(guildId); if (!s) return; this.stopDecoder(s); this.sessions.delete(guildId); await s.room.disconnect(); await this.leaveSignaling(guildId); console.log("[Voice] Disconnected"); }
  isConnected(guildId: string) { return this.sessions.get(guildId)?.room.isConnected ?? false; }
  channelId(guildId: string) { return this.sessions.get(guildId)?.channelId ?? this.connections.get(guildId)?.channelId; }
  onPlayback(listener: (event: PlaybackEvent) => void) { this.events.on("playback", listener); return () => this.events.off("playback", listener); }
  async shutdown() { await Promise.all([...new Set([...this.sessions.keys(), ...this.connections.keys()])].map(id => this.disconnect(id))); }
  private ensureActive(attempt: ConnectionAttempt) { if (attempt.cancelled) throw new Error("Voice connection was cancelled."); }
  private require(guildId: string) { const session = this.sessions.get(guildId); if (!session) throw new Error("Voice is not connected."); return session; }
  private stopDecoder(session: Session) { if (!session.decoder) return; session.manualGeneration = session.generation; session.decoder.stop(); session.decoder = undefined; }
  private finish(guildId: string, generation: number, type: "ended" | "error", error?: Error) { const s = this.sessions.get(guildId); if (!s || s.generation !== generation || s.manualGeneration === generation) return; s.decoder = undefined; this.events.emit("playback", { guildId, generation, type, error } satisfies PlaybackEvent); }
}
