import test from "node:test";
import assert from "node:assert/strict";
import { SourceManager } from "./manager.js";
import { DirectMediaProvider } from "./direct.js";
import { SoundCloudProvider } from "./soundcloud.js";
import { YouTubeProvider } from "./youtube.js";
import { UnplayableSourceError } from "./types.js";
import { PlayerManager } from "../player.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sc = { id: 42, title: "A track", duration: 123000, permalink_url: "https://soundcloud.com/artist/a-track", artwork_url: "https://img.example/a.jpg", access: "playable", streamable: true, user: { username: "Artist", permalink_url: "https://soundcloud.com/artist" } };

test("detects providers and resolves only direct HTTP media unchanged", async () => {
  const manager = new SourceManager([new SoundCloudProvider("id", "secret"), new YouTubeProvider("key"), new DirectMediaProvider()]);
  assert.equal(manager.detect("https://soundcloud.com/artist/track")?.id, "soundcloud");
  assert.equal(manager.detect("https://youtube.com/watch?v=x")?.id, "youtube");
  assert.equal(manager.detect("https://media.example/track.aac")?.id, "direct");
  assert.equal(manager.detect("file:///etc/passwd"), undefined);
  const [track] = await manager.search("https://media.example/track.aac", 1);
  const playable = await manager.resolve(track); assert.equal(playable.inputUrl, track.url); assert.equal(playable.ephemeral, false);
});

test("SoundCloud search stores stable metadata and never a stream URL", async () => {
  const calls: string[] = []; const fetcher: typeof fetch = async input => { const url = String(input); calls.push(url); return url.includes("oauth/token") ? json({ access_token: "TOKEN", expires_in: 3600 }) : json({ collection: [sc] }); };
  const provider = new SoundCloudProvider("id", "secret", fetcher); const [track] = await provider.search("track", 2);
  assert.equal(track.provider, "soundcloud"); assert.equal(track.providerId, "42"); assert.equal(track.url, sc.permalink_url); assert.equal(JSON.stringify(track).includes("TOKEN"), false); assert.equal(calls.some(x => x.includes("streams")), false);
});

test("SoundCloud caches tokens and concurrent callers share refresh", async () => {
  let tokens = 0; const fetcher: typeof fetch = async input => { if (String(input).includes("oauth/token")) { tokens++; await new Promise(r => setTimeout(r, 5)); return json({ access_token: `token-${tokens}`, expires_in: 3600 }); } return json({ collection: [sc] }); };
  const provider = new SoundCloudProvider("id", "secret", fetcher);
  await Promise.all([provider.search("a", 1), provider.search("b", 1), provider.search("c", 1)]); assert.equal(tokens, 1);
  await provider.search("d", 1); assert.equal(tokens, 1);
});

test("SoundCloud refreshes expired tokens", async () => {
  let now = 0, tokens = 0; const fetcher: typeof fetch = async input => String(input).includes("oauth/token") ? json({ access_token: `token-${++tokens}`, expires_in: 120 }) : json({ collection: [sc] });
  const provider = new SoundCloudProvider("id", "secret", fetcher, () => now); await provider.search("a", 1); now = 61_000; await provider.search("b", 1); assert.equal(tokens, 2);
});

test("SoundCloud resolves AAC HLS at playback time and prefers 160 kbps", async () => {
  const calls: string[] = []; const fetcher: typeof fetch = async input => { const url = String(input); calls.push(url); if (url.includes("oauth/token")) return json({ access_token: "TOKEN", expires_in: 3600 }); if (url.endsWith("/streams")) return json({ hls_aac_96_url: "https://cdn.example/96.m3u8?sig=secret", hls_aac_160_url: "https://cdn.example/160.m3u8?sig=secret" }); return json(sc); };
  const provider = new SoundCloudProvider("id", "secret", fetcher); const track = await provider.fromUrl(sc.permalink_url); assert.equal(calls.some(x => x.endsWith("/streams")), false);
  const playable = await provider.resolve(track); assert.match(playable.inputUrl, /160\.m3u8/); assert.equal(playable.ephemeral, true); assert.equal(JSON.stringify(track).includes("m3u8"), false);
});

test("SoundCloud blocked tracks return a useful error", async () => {
  const fetcher: typeof fetch = async input => String(input).includes("oauth/token") ? json({ access_token: "TOKEN", expires_in: 3600 }) : json({ ...sc, access: "blocked" });
  const provider = new SoundCloudProvider("id", "secret", fetcher);
  await assert.rejects(provider.resolve({ id: "soundcloud:42", providerId: "42", provider: "soundcloud", title: "x", artist: "x", duration: 0, url: sc.permalink_url }), (error: unknown) => error instanceof UnplayableSourceError && /not available/.test(error.message));
});

test("YouTube search remains metadata-only", async () => {
  const provider = new YouTubeProvider("key", async () => json({ items: [{ id: { videoId: "abc" }, snippet: { title: "Video", channelTitle: "Channel", thumbnails: { high: { url: "https://img" } } } }] }));
  const [track] = await provider.search("video", 1); assert.equal(track.provider, "youtube"); assert.equal(track.playable, false);
  await assert.rejects(provider.resolve(track), /playback is not currently supported/);
});

test("player snapshots strip provider secrets and ephemeral URLs", () => {
  const players = new PlayerManager(); players.add("g", [{ id: "1", title: "x", artist: "x", duration: 0, url: "https://soundcloud.com/a/b", provider: "soundcloud", authorization: "OAuth secret", inputUrl: "https://signed.example/x" } as never]);
  const value = JSON.stringify(players.snapshot("g")); assert.equal(value.includes("OAuth secret"), false); assert.equal(value.includes("signed.example"), false);
});
