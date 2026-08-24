import type { Track } from "../types.js";
import { UnplayableSourceError, type MediaProvider } from "./types.js";

export class YouTubeProvider implements MediaProvider {
  readonly id = "youtube" as const; readonly supportsPlayback = false;
  constructor(private readonly apiKey = process.env.YOUTUBE_API_KEY, private readonly fetcher: typeof fetch = fetch) {}
  canHandle(input: string) { try { return /(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(input).hostname); } catch { return false; } }
  async search(query: string, limit: number): Promise<Track[]> {
    if (!this.apiKey) return [];
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({ part: "snippet", type: "video,playlist", maxResults: String(limit), q: query, key: this.apiKey }).toString();
    const response = await this.fetcher(url); if (!response.ok) throw new Error(`YouTube search failed (${response.status})`);
    const body = await response.json() as { items: Array<{ id: { videoId?: string; playlistId?: string }; snippet: { title: string; channelTitle: string; thumbnails?: { high?: { url: string } } } }> };
    return body.items.map(item => { const id = item.id.videoId ?? item.id.playlistId ?? "unknown"; const playlist = Boolean(item.id.playlistId); const webUrl = playlist ? `https://youtube.com/playlist?list=${id}` : `https://youtube.com/watch?v=${id}`;
      return { id: `youtube:${id}`, providerId: id, provider: "youtube", playable: false, title: item.snippet.title, artist: item.snippet.channelTitle, duration: 0, artwork: item.snippet.thumbnails?.high?.url, playlistId: playlist ? id : undefined, url: webUrl, webUrl };
    });
  }
  async fromUrl(input: string): Promise<Track> { return { id: `youtube:${input}`, provider: "youtube", title: "YouTube link", artist: "YouTube", duration: 0, url: input, webUrl: input, playable: false }; }
  async resolve(_track: Track): Promise<never> { throw new UnplayableSourceError("Aria can find that YouTube result, but YouTube playback is not currently supported."); }
}
