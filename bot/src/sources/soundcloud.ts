import type { Track } from "../types.js";
import { ProviderUnavailableError, UnplayableSourceError, type MediaProvider, type PlayableMedia } from "./types.js";

interface Token { access_token: string; expires_in: number }
interface ScTrack { id: number; urn?: string; title: string; duration?: number; permalink_url: string; artwork_url?: string; access?: "playable" | "preview" | "blocked"; streamable?: boolean; user: { username: string; permalink_url?: string } }
interface Streams { hls_aac_160_url?: string; hls_aac_96_url?: string }

export class SoundCloudProvider implements MediaProvider {
  readonly id = "soundcloud" as const; readonly supportsPlayback = true;
  private token?: { value: string; expiresAt: number }; private refreshing?: Promise<string>;
  constructor(private readonly clientId = process.env.SOUNDCLOUD_CLIENT_ID, private readonly clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET, private readonly fetcher: typeof fetch = fetch, private readonly now = () => Date.now()) {}
  canHandle(input: string) { try { const u = new URL(input); return u.protocol === "https:" && /(^|\.)soundcloud\.com$/i.test(u.hostname) && u.pathname.split("/").filter(Boolean).length >= 2; } catch { return false; } }
  private async accessToken() {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!this.clientId || !this.clientSecret) throw new ProviderUnavailableError("SoundCloud search and playback are not configured.");
      const response = await this.fetcher("https://secure.soundcloud.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret }) });
      if (!response.ok) throw new ProviderUnavailableError("I couldn't reach SoundCloud right now.");
      const token = await response.json() as Token; this.token = { value: token.access_token, expiresAt: this.now() + token.expires_in * 1000 }; return token.access_token;
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
  private track(value: ScTrack): Track {
    return { id: `soundcloud:${value.id}`, providerId: String(value.id), provider: "soundcloud", playable: value.access !== "blocked" && value.streamable !== false, title: value.title, artist: value.user.username, duration: Math.round((value.duration ?? 0) / 1000), artwork: value.artwork_url, url: value.permalink_url, webUrl: value.permalink_url, attribution: { service: "SoundCloud", uploaderUrl: value.user.permalink_url } };
  }
  private async api<T>(path: string): Promise<T> {
    const response = await this.fetcher(`https://api.soundcloud.com${path}`, { headers: { Authorization: `OAuth ${await this.accessToken()}`, Accept: "application/json" } });
    if (!response.ok) throw new ProviderUnavailableError("I couldn't reach SoundCloud right now."); return response.json() as Promise<T>;
  }
  async search(query: string, limit: number): Promise<Track[]> { const body = await this.api<{ collection: ScTrack[] }>(`/tracks?q=${encodeURIComponent(query)}&limit=${limit}&access=playable`); return body.collection.filter(x => x.access !== "blocked" && x.streamable !== false).map(x => this.track(x)); }
  async fromUrl(input: string) { if (!this.canHandle(input)) throw new UnplayableSourceError("That is not a SoundCloud track URL."); return this.track(await this.api<ScTrack>(`/resolve?url=${encodeURIComponent(input)}`)); }
  async resolve(track: Track, positionSeconds = 0): Promise<PlayableMedia> {
    const id = track.providerId ?? track.id.replace(/^soundcloud:/, "");
    const current = await this.api<ScTrack>(`/tracks/${encodeURIComponent(id)}`);
    if (current.access === "blocked" || current.streamable === false) throw new UnplayableSourceError("That SoundCloud track is not available for off-platform streaming.");
    const streams = await this.api<Streams>(`/tracks/${encodeURIComponent(id)}/streams`); const inputUrl = streams.hls_aac_160_url ?? streams.hls_aac_96_url;
    if (!inputUrl) throw new UnplayableSourceError("That SoundCloud track is not available for off-platform streaming.");
    try { if (!["http:", "https:"].includes(new URL(inputUrl).protocol)) throw new Error(); } catch { throw new UnplayableSourceError("SoundCloud returned an invalid media stream."); }
    return { track, inputUrl, positionSeconds, provider: "soundcloud", ephemeral: true };
  }
}
