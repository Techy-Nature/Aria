import type { MediaProviderId, Track } from "../types.js";
import { DirectMediaProvider } from "./direct.js";
import { SoundCloudProvider } from "./soundcloud.js";
import { YouTubeProvider } from "./youtube.js";
import { UnplayableSourceError, type MediaProvider } from "./types.js";

const PREFIXES: Record<string, MediaProviderId> = { "sc": "soundcloud", "soundcloud": "soundcloud", "yt": "youtube", "youtube": "youtube" };
export class SourceManager {
  constructor(readonly providers: MediaProvider[] = [new SoundCloudProvider(), new YouTubeProvider(), new DirectMediaProvider()]) {}
  detect(input: string) { return this.providers.find(provider => provider.canHandle(input)); }
  private parsed(query: string) { const match = /^([a-z]+):\s*(.+)$/i.exec(query); return match && PREFIXES[match[1].toLowerCase()] ? { provider: PREFIXES[match[1].toLowerCase()], query: match[2] } : { query }; }
  async search(query: string, limit: number, playableOnly = false): Promise<Track[]> {
    const urlProvider = this.detect(query); if (urlProvider?.fromUrl) return [await urlProvider.fromUrl(query)];
    if (/^[a-z][a-z0-9+.-]*:/i.test(query) || /^https?:\/\//i.test(query)) throw new UnplayableSourceError("only supported HTTP(S) media and provider URLs are allowed.");
    const parsed = this.parsed(query); const providers = this.providers.filter(p => p.search && (!parsed.provider || p.id === parsed.provider) && (!playableOnly || p.supportsPlayback));
    const settled = await Promise.allSettled(providers.map(p => p.search!(parsed.query, limit)));
    const results = settled.flatMap(x => x.status === "fulfilled" ? x.value : []); if (!results.length && settled.some(x => x.status === "rejected")) throw (settled.find(x => x.status === "rejected") as PromiseRejectedResult).reason;
    return results.slice(0, limit);
  }
  async resolve(track: Track, positionSeconds = 0) { const provider = track.provider ? this.providers.find(x => x.id === track.provider) : this.detect(track.url); if (!provider) throw new UnplayableSourceError("this result does not contain a supported playable media URL."); return provider.resolve(track, positionSeconds); }
}
