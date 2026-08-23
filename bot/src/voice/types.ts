import type { Track } from "../types.js";

export interface AudioSource { track: Track; inputUrl: string; positionSeconds?: number }
export type PlaybackEvent = { guildId: string; generation: number; type: "ended" | "error"; error?: Error };
export interface VoiceTransport {
  connect(guildId: string, channelId: string): Promise<void>;
  disconnect(guildId: string): Promise<void>;
  play(guildId: string, source: AudioSource, generation: number): Promise<void>;
  pause(guildId: string): Promise<void>;
  resume(guildId: string): Promise<void>;
  stop(guildId: string): Promise<void>;
  seek(guildId: string, positionSeconds: number, generation: number): Promise<void>;
  isConnected(guildId: string): boolean;
  channelId(guildId: string): string | undefined;
  onPlayback(listener: (event: PlaybackEvent) => void): () => void;
  shutdown(): Promise<void>;
}
