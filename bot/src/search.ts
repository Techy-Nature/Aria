import type { Track } from "./types.js";

/** Search provider. Configure YOUTUBE_API_KEY for real YouTube results; URL inputs work without it. */
export class SearchService {
  constructor(private readonly apiKey = process.env.YOUTUBE_API_KEY) {}
  async search(query: string, limit: number): Promise<Track[]> {
    if (/^https?:\/\//i.test(query)) return [{ id: query, title: "Linked track or playlist", url: query, artist: "Linked media", duration: 0 }];
    if (!this.apiKey) {
      return Array.from({ length: limit }, (_, i) => ({ id: `${query}-${i}`, title: `${query} — result ${i + 1}`, artist: "Search preview", url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, duration: 0 }));
    }
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({ part: "snippet", type: "video,playlist", maxResults: String(limit), q: query, key: this.apiKey }).toString();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    const body = await response.json() as { items: Array<{ id: { videoId?: string; playlistId?: string }; snippet: { title: string; channelTitle: string; thumbnails?: { high?: { url: string } } } }> };
    return body.items.map(item => {
      const id = item.id.videoId ?? item.id.playlistId ?? "unknown";
      const playlist = Boolean(item.id.playlistId);
      return { id, title: item.snippet.title, artist: item.snippet.channelTitle, duration: 0,
        artwork: item.snippet.thumbnails?.high?.url, playlistId: playlist ? id : undefined,
        url: playlist ? `https://youtube.com/playlist?list=${id}` : `https://youtube.com/watch?v=${id}` };
    });
  }
}
