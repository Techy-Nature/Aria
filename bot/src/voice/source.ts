import type { Track } from "../types.js";
import type { AudioSource } from "./types.js";

export class UnplayableSourceError extends Error {}

export interface PlayableSourceResolver {
  resolve(track: Track, positionSeconds?: number): Promise<AudioSource>;
}

/** Resolves only direct media inputs; search result pages remain metadata. */
export class DirectMediaResolver implements PlayableSourceResolver {
  async resolve(track: Track, positionSeconds = 0): Promise<AudioSource> {
    let url: URL;
    try { url = new URL(track.url); } catch { throw new UnplayableSourceError("this result does not contain a playable media URL."); }
    if (!["http:", "https:"].includes(url.protocol)) throw new UnplayableSourceError("only direct HTTP(S) media URLs are supported.");
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)) {
      throw new UnplayableSourceError("this search result is metadata-only. Please provide a supported direct media URL.");
    }
    return { track, inputUrl: url.toString(), positionSeconds };
  }
}
