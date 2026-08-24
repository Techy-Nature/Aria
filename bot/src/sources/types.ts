import type { Track, MediaProviderId } from "../types.js";
import type { AudioSource } from "../voice/types.js";

export class UnplayableSourceError extends Error {}
export class ProviderUnavailableError extends Error {}

export interface PlayableMedia extends AudioSource {
  track: Track;
  provider: MediaProviderId;
  ephemeral: boolean;
  expiresAt?: number;
}

export interface MediaProvider {
  readonly id: MediaProviderId;
  readonly supportsPlayback: boolean;
  canHandle(input: string): boolean;
  search?(query: string, limit: number): Promise<Track[]>;
  fromUrl?(input: string): Promise<Track>;
  resolve(track: Track, positionSeconds?: number): Promise<PlayableMedia>;
}
