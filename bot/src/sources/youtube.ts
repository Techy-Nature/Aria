import type { Track } from "../types.js";
import { UnplayableSourceError, type MediaProvider } from "./types.js";
import { YtDlpResolver, validateYtDlpUrl } from "./ytdlp.js";

export class YouTubeProvider implements MediaProvider {
  readonly id = "youtube" as const;
  get supportsPlayback() { return this.resolver.available; }
  constructor(private readonly apiKey = process.env.YOUTUBE_API_KEY, private readonly fetcher: typeof fetch = fetch, private readonly resolver = new YtDlpResolver()) {}
  canHandle(input: string) { try { validateYtDlpUrl(input); return true; } catch { return false; } }
  async search(query: string, limit: number): Promise<Track[]> {
    if (!this.apiKey) return [];
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({ part: "snippet", type: "video,playlist", maxResults: String(limit), q: query, key: this.apiKey }).toString();
    const response = await this.fetcher(url); if (!response.ok) throw new Error(`YouTube search failed (${response.status})`);
    const body = await response.json() as { items: Array<{ id: { videoId?: string; playlistId?: string }; snippet: { title: string; channelTitle: string; thumbnails?: { high?: { url: string } } } }> };
    return body.items.map(item => { const id = item.id.videoId ?? item.id.playlistId ?? "unknown"; const playlist = Boolean(item.id.playlistId); const webUrl = playlist ? `https://youtube.com/playlist?list=${id}` : `https://youtube.com/watch?v=${id}`;
      return { id: `youtube:${id}`, providerId: id, provider: "youtube", playable: !playlist && this.supportsPlayback, title: item.snippet.title, artist: item.snippet.channelTitle, duration: 0, artwork: item.snippet.thumbnails?.high?.url, playlistId: playlist ? id : undefined, url: webUrl, webUrl };
    });
  }
  private async playlist(playlistId: string): Promise<Track[]> {
    if (!this.apiKey) throw new UnplayableSourceError("YouTube playlist importing requires YOUTUBE_API_KEY.");
    if (!/^[A-Za-z0-9_-]+$/.test(playlistId)) throw new UnplayableSourceError("That YouTube URL contains an invalid playlist identifier.");
    type PlaylistItem = { snippet: { title: string; channelTitle: string; videoOwnerChannelTitle?: string; resourceId?: { videoId?: string }; thumbnails?: { high?: { url: string }; medium?: { url: string } } }; status?: { privacyStatus?: string } };
    const tracks: Track[] = []; let pageToken: string | undefined;
    do {
      const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      url.search = new URLSearchParams({ part: "snippet,status", playlistId, maxResults: "50", key: this.apiKey, ...(pageToken ? { pageToken } : {}) }).toString();
      const response = await this.fetcher(url); if (!response.ok) throw new UnplayableSourceError(response.status === 404 ? "That YouTube playlist is unavailable or private." : `YouTube playlist import failed (${response.status}).`);
      const body = await response.json() as { items?: PlaylistItem[]; nextPageToken?: string };
      for (const item of body.items ?? []) {
        const videoId = item.snippet.resourceId?.videoId;
        if (!videoId || item.status?.privacyStatus === "private" || /^(Private video|Deleted video)$/i.test(item.snippet.title)) continue;
        const webUrl = `https://www.youtube.com/watch?v=${videoId}`;
        tracks.push({ id: `youtube:${videoId}`, providerId: videoId, provider: "youtube", playable: this.supportsPlayback, title: item.snippet.title, artist: item.snippet.videoOwnerChannelTitle ?? item.snippet.channelTitle, duration: 0, artwork: item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.medium?.url, playlistId, url: webUrl, webUrl });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    if (!tracks.length) throw new UnplayableSourceError("That YouTube playlist does not contain any available videos.");
    return tracks;
  }
  async fromUrl(input: string): Promise<Track | Track[]> {
    const url = validateYtDlpUrl(input); const playlistId = url.searchParams.get("list");
    if (playlistId) return this.playlist(playlistId);
    const id = url.hostname === "youtu.be" ? url.pathname.split("/")[1] : url.searchParams.get("v");
    if (!id) throw new UnplayableSourceError("That YouTube URL does not contain a video.");
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new UnplayableSourceError("That YouTube URL contains an invalid video identifier.");
    const music = url.hostname === "music.youtube.com"; const webUrl = `${music ? "https://music.youtube.com" : "https://www.youtube.com"}/watch?v=${id}`;
    return { id: `youtube:${id}`, providerId: id, provider: "youtube", title: "YouTube link", artist: music ? "YouTube Music" : "YouTube", duration: 0, url: webUrl, webUrl, playable: this.supportsPlayback };
  }
  async resolve(track: Track, positionSeconds = 0) {
    const media = await this.resolver.resolve(track.webUrl ?? track.url);
    return { track, provider: this.id, positionSeconds, ephemeral: true, ...media };
  }
  shutdown() { this.resolver.shutdown(); }
}
