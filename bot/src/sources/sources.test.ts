import test from "node:test";
import assert from "node:assert/strict";
import { SourceManager } from "./manager.js";
import { DirectMediaProvider } from "./direct.js";
import { SoundCloudProvider } from "./soundcloud.js";
import { YouTubeProvider } from "./youtube.js";
import { UnplayableSourceError } from "./types.js";
import { PlayerManager } from "../player.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sc = { urn: "soundcloud:tracks:42", id: 42, title: "A track", duration: 123000, permalink_url: "https://soundcloud.com/artist/a-track", artwork_url: "https://img.example/a.jpg", access: "playable", streamable: true, user: { username: "Artist", permalink_url: "https://soundcloud.com/artist" } };
function oauthRequest(init?: RequestInit) {
  const headers = new Headers(init?.headers); const authorization = headers.get("authorization") ?? ""; const body = new URLSearchParams(String(init?.body));
  return { authorization, decoded: authorization.startsWith("Basic ") ? Buffer.from(authorization.slice(6), "base64").toString("utf8") : "", body };
}

test("detects providers and resolves only direct HTTP media unchanged", async () => {
  const manager = new SourceManager([new SoundCloudProvider("id", "secret"), new YouTubeProvider("key"), new DirectMediaProvider()]);
  assert.equal(manager.detect("https://soundcloud.com/artist/track")?.id, "soundcloud");
  assert.equal(manager.detect("https://youtube.com/watch?v=x")?.id, "youtube");
  assert.equal(manager.detect("https://media.example/track.aac")?.id, "direct");
  assert.equal(manager.detect("file:///etc/passwd"), undefined);
  const [track] = await manager.search("https://media.example/track.aac", 1);
  const playable = await manager.resolve(track); assert.equal(playable.inputUrl, track.url); assert.equal(playable.ephemeral, false);
});

test("SoundCloud client credentials use Basic auth and stable URN metadata", async () => {
  const calls: string[] = []; let auth: ReturnType<typeof oauthRequest> | undefined; const fetcher: typeof fetch = async (input, init) => { const url = String(input); calls.push(url); if (url.includes("oauth/token")) { auth = oauthRequest(init); return json({ access_token: "TOKEN", refresh_token: "REFRESH-1", expires_in: 3600 }); } return json({ collection: [sc] }); };
  const provider = new SoundCloudProvider("id", "secret", fetcher); const [track] = await provider.search("track", 2);
  assert.match(auth!.authorization, /^Basic /); assert.equal(auth!.decoded, "id:secret"); assert.equal(auth!.body.get("grant_type"), "client_credentials"); assert.equal(auth!.body.has("client_id"), false); assert.equal(auth!.body.has("client_secret"), false);
  const search = new URL(calls.find(url => url.startsWith("https://api.soundcloud.com/tracks?"))!); assert.equal(search.searchParams.get("q"), "track"); assert.equal(search.searchParams.get("access"), "playable"); assert.equal(search.searchParams.get("linked_partitioning"), "true"); assert.equal(search.searchParams.get("limit"), "2");
  assert.equal(track.provider, "soundcloud"); assert.equal(track.providerId, sc.urn); assert.equal(track.id, sc.urn); assert.equal(track.url, sc.permalink_url); assert.equal(JSON.stringify(track).includes("TOKEN"), false); assert.equal(calls.some(x => x.includes("streams")), false);
});

test("SoundCloud caches tokens and concurrent callers share refresh", async () => {
  let tokens = 0; const fetcher: typeof fetch = async input => { if (String(input).includes("oauth/token")) { tokens++; await new Promise(r => setTimeout(r, 5)); return json({ access_token: `token-${tokens}`, expires_in: 3600 }); } return json({ collection: [sc] }); };
  const provider = new SoundCloudProvider("id", "secret", fetcher);
  await Promise.all([provider.search("a", 1), provider.search("b", 1), provider.search("c", 1)]); assert.equal(tokens, 1);
  await provider.search("d", 1); assert.equal(tokens, 1);
});

test("SoundCloud uses and replaces single-use refresh tokens after expiry", async () => {
  let now = 0; const grants: Array<{ body: Record<string, string>; authorization: string }> = []; const fetcher: typeof fetch = async (input, init) => { if (!String(input).includes("oauth/token")) return json({ collection: [sc] }); const request = oauthRequest(init); grants.push({ body: Object.fromEntries(request.body), authorization: request.authorization }); return request.body.get("grant_type") === "client_credentials" ? json({ access_token: "token-1", refresh_token: "refresh-1", expires_in: 120 }) : json({ access_token: "token-2", refresh_token: "refresh-2", expires_in: 120 }); };
  const provider = new SoundCloudProvider("id", "secret", fetcher, () => now); await provider.search("a", 1); now = 61_000; await provider.search("b", 1); now = 122_000; await provider.search("c", 1);
  assert.match(grants[0].authorization, /^Basic /); assert.deepEqual(grants[0].body, { grant_type: "client_credentials" });
  assert.equal(grants[1].authorization, ""); assert.deepEqual(grants[1].body, { grant_type: "refresh_token", client_id: "id", client_secret: "secret", refresh_token: "refresh-1" });
  assert.equal(grants[2].authorization, ""); assert.deepEqual(grants[2].body, { grant_type: "refresh_token", client_id: "id", client_secret: "secret", refresh_token: "refresh-2" });
});

test("SoundCloud concurrent expiry refresh is deduplicated", async () => {
  let now = 0, tokenRequests = 0; const fetcher: typeof fetch = async (input, init) => { if (!String(input).includes("oauth/token")) return json({ collection: [sc] }); tokenRequests++; const grant = oauthRequest(init).body.get("grant_type"); if (grant === "refresh_token") await new Promise(resolve => setTimeout(resolve, 5)); return json({ access_token: `token-${tokenRequests}`, refresh_token: `refresh-${tokenRequests}`, expires_in: 120 }); };
  const provider = new SoundCloudProvider("id", "secret", fetcher, () => now); await provider.search("initial", 1); now = 61_000; await Promise.all([provider.search("a", 1), provider.search("b", 1), provider.search("c", 1)]); assert.equal(tokenRequests, 2);
});

test("SoundCloud falls back to client credentials when refresh fails", async () => {
  let now = 0; const grants: string[] = []; const fetcher: typeof fetch = async (input, init) => { if (!String(input).includes("oauth/token")) return json({ collection: [sc] }); const grant = oauthRequest(init).body.get("grant_type")!; grants.push(grant); if (grant === "refresh_token") return json({ error: "invalid_grant" }, 401); return json({ access_token: `token-${grants.length}`, refresh_token: `refresh-${grants.length}`, expires_in: 120 }); };
  const provider = new SoundCloudProvider("id", "secret", fetcher, () => now); await provider.search("a", 1); now = 61_000; await provider.search("b", 1); assert.deepEqual(grants, ["client_credentials", "refresh_token", "client_credentials"]);
});

test("SoundCloud resolves AAC HLS at playback time and prefers 160 kbps", async () => {
  const calls: string[] = []; const fetcher: typeof fetch = async input => { const url = String(input); calls.push(url); if (url.includes("oauth/token")) return json({ access_token: "TOKEN", expires_in: 3600 }); if (url.endsWith("/streams")) return json({ hls_aac_96_url: "https://cdn.example/96.m3u8?sig=secret", hls_aac_160_url: "https://cdn.example/160.m3u8?sig=secret" }); return json(sc); };
  const provider = new SoundCloudProvider("id", "secret", fetcher); const track = await provider.fromUrl(sc.permalink_url); assert.equal(calls.some(x => x.endsWith("/streams")), false);
  const playable = await provider.resolve(track); assert.match(playable.inputUrl, /160\.m3u8/); assert.equal(playable.ephemeral, true); assert.equal(JSON.stringify(track).includes("m3u8"), false);
  assert.ok(calls.includes("https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A42")); assert.ok(calls.includes("https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A42/streams"));
});

test("SoundCloud blocked tracks return a useful error", async () => {
  const fetcher: typeof fetch = async input => String(input).includes("oauth/token") ? json({ access_token: "TOKEN", expires_in: 3600 }) : json({ ...sc, access: "blocked" });
  const provider = new SoundCloudProvider("id", "secret", fetcher);
  await assert.rejects(provider.resolve({ id: sc.urn, providerId: sc.urn, provider: "soundcloud", title: "x", artist: "x", duration: 0, url: sc.permalink_url }), (error: unknown) => error instanceof UnplayableSourceError && /not available/.test(error.message));
});

test("YouTube Data API search keeps stable metadata and reflects resolver availability", async () => {
  const resolver = { available: true, resolve: async () => ({ inputUrl: "https://signed.example/audio" }) };
  const provider = new YouTubeProvider("key", async () => json({ items: [{ id: { videoId: "abc" }, snippet: { title: "Video", channelTitle: "Channel", thumbnails: { high: { url: "https://img" } } } }] }), resolver as never);
  const [track] = await provider.search("video", 1); assert.equal(track.provider, "youtube"); assert.equal(track.providerId, "abc"); assert.equal(track.url, "https://youtube.com/watch?v=abc"); assert.equal(track.playable, true);
  const media = await provider.resolve(track); assert.equal(media.ephemeral, true); assert.equal(JSON.stringify(track).includes("signed.example"), false);
});

test("player snapshots strip provider secrets and ephemeral URLs", () => {
  const players = new PlayerManager(); players.add("g", [{ id: "1", title: "x", artist: "x", duration: 0, url: "https://soundcloud.com/a/b", provider: "soundcloud", authorization: "OAuth secret", inputUrl: "https://signed.example/x" } as never]);
  const value = JSON.stringify(players.snapshot("g")); assert.equal(value.includes("OAuth secret"), false); assert.equal(value.includes("signed.example"), false);
});
