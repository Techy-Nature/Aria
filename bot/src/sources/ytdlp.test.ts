import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { YtDlpResolver, validateYtDlpUrl } from "./ytdlp.js";
import { MAX_PLAYLIST_PAGES, MAX_PLAYLIST_TRACKS, YouTubeProvider } from "./youtube.js";
import { SourceManager } from "./manager.js";

async function fakeYtDlp(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "aria-ytdlp-")); const path = join(dir, "yt-dlp");
  await writeFile(path, `#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log('test'); else { ${body} }\n`); await chmod(path, 0o755); return path;
}

test("yt-dlp URL allowlist accepts YouTube variants and rejects unsafe schemes/hosts", () => {
  for (const url of ["https://youtube.com/watch?v=x", "https://www.youtube.com/watch?v=x", "https://youtu.be/x", "https://music.youtube.com/watch?v=x"]) assert.doesNotThrow(() => validateYtDlpUrl(url));
  for (const url of ["https://example.com/x", "file:///etc/passwd", "http://127.0.0.1/x", "http://10.0.0.1/x", "http://localhost/x", "data:text/plain,x"]) assert.throws(() => validateYtDlpUrl(url), /not supported|valid/);
});

test("YouTube URLs normalize to stable video metadata without resolving", async () => {
  let calls = 0; const resolver = { available: true, resolve: async () => { calls++; return { inputUrl: "https://cdn/x" }; } };
  const provider = new YouTubeProvider(undefined, fetch, resolver as never);
  const music = await provider.fromUrl("https://music.youtube.com/watch?v=abc"); assert.ok(!Array.isArray(music)); assert.equal(music.providerId, "abc"); assert.equal(music.webUrl, "https://music.youtube.com/watch?v=abc"); assert.equal(calls, 0);
  const short = await provider.fromUrl("https://youtu.be/def?t=3"); assert.ok(!Array.isArray(short)); assert.equal(short.webUrl, "https://www.youtube.com/watch?v=def");
  await assert.rejects(provider.fromUrl("https://youtube.com/playlist?list=PL1"), /YOUTUBE_API_KEY/);
});

test("watch and short URLs with list parameters remain single videos", async () => {
  const provider = new YouTubeProvider("key", async () => { throw new Error("playlist API must not be called"); }, { available: true } as never);
  for (const input of ["https://youtube.com/watch?v=abc&list=PL123", "https://music.youtube.com/watch?v=abc&list=PL123", "https://youtu.be/abc?list=PL123"]) {
    const track = await provider.fromUrl(input); assert.ok(!Array.isArray(track)); assert.equal(track.providerId, "abc"); assert.equal(track.playlistId, undefined);
  }
});

test("playable search filters playlist results before applying the limit", async () => {
  let requestedType: string | null = null;
  const fetcher: typeof fetch = async input => { requestedType = new URL(String(input)).searchParams.get("type"); return new Response(JSON.stringify({ items: [
    { id: { playlistId: "playlist" }, snippet: { title: "Playlist", channelTitle: "Owner" } },
    { id: { videoId: "video-a" }, snippet: { title: "Video A", channelTitle: "Artist" } },
    { id: { videoId: "video-b" }, snippet: { title: "Video B", channelTitle: "Artist" } }
  ] }), { status: 200 }); };
  const provider = new YouTubeProvider("key", fetcher, { available: true } as never); const manager = new SourceManager([provider]);
  const results = await manager.search("song title", 1, true); assert.equal(requestedType, "video"); assert.deepEqual(results.map(track => track.providerId), ["video-a"]);
  const all = await manager.search("song title", 3); assert.equal(requestedType, "video,playlist"); assert.deepEqual(all.map(track => track.providerId), ["playlist", "video-a", "video-b"]);
});

test("YouTube playlist import follows every API page and creates stable playable tracks", async () => {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url); const second = url.searchParams.get("pageToken") === "next";
    return new Response(JSON.stringify(second ? { items: [{ snippet: { title: "Two", channelTitle: "Owner", resourceId: { videoId: "two" } }, status: { privacyStatus: "public" } }] } : { nextPageToken: "next", items: [
      { snippet: { title: "One", channelTitle: "Playlist owner", videoOwnerChannelTitle: "Artist", resourceId: { videoId: "one" }, thumbnails: { high: { url: "https://img/one" } } }, status: { privacyStatus: "public" } },
      { snippet: { title: "Private video", channelTitle: "Owner", resourceId: { videoId: "hidden" } }, status: { privacyStatus: "private" } }
    ] }), { status: 200 });
  };
  const provider = new YouTubeProvider("key", fetcher, { available: true, resolve: async () => ({ inputUrl: "https://cdn/audio" }), shutdown() {} } as never);
  const tracks = await provider.fromUrl("https://www.youtube.com/playlist?list=PL_test"); assert.ok(Array.isArray(tracks));
  assert.deepEqual(tracks.map(track => track.providerId), ["one", "two"]); assert.ok(tracks.every(track => track.playlistId === "PL_test" && track.playable));
  assert.equal(tracks[0].artist, "Artist"); assert.equal(tracks[0].url, "https://www.youtube.com/watch?v=one"); assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("maxResults"), "50"); assert.equal(requests[1].searchParams.get("pageToken"), "next");
});

test("playlist import stops pagination at the page limit and excludes unavailable entries", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ nextPageToken: `page-${calls}`, items: [
    { snippet: { title: "Private video", channelTitle: "Owner", resourceId: { videoId: `private-${calls}` } }, status: { privacyStatus: "private" } },
    { snippet: { title: "Deleted video", channelTitle: "Owner", resourceId: { videoId: `deleted-${calls}` } }, status: { privacyStatus: "public" } },
    { snippet: { title: `Usable ${calls}`, channelTitle: "Owner", resourceId: { videoId: `usable-${calls}` } }, status: { privacyStatus: "public" } }
  ] }), { status: 200 }); };
  const provider = new YouTubeProvider("key", fetcher, { available: true } as never); const tracks = await provider.fromUrl("https://youtube.com/playlist?list=PL_pages"); assert.ok(Array.isArray(tracks));
  assert.equal(calls, MAX_PLAYLIST_PAGES); assert.equal(tracks.length, MAX_PLAYLIST_PAGES); assert.ok(tracks.every(track => track.title.startsWith("Usable")));
});

test("playlist import never stores more than the track limit", async () => {
  let calls = 0; const items = Array.from({ length: MAX_PLAYLIST_TRACKS + 20 }, (_, index) => ({ snippet: { title: `Track ${index}`, channelTitle: "Owner", resourceId: { videoId: `video-${index}` } }, status: { privacyStatus: "public" } }));
  const provider = new YouTubeProvider("key", async () => { calls++; return new Response(JSON.stringify({ nextPageToken: "must-not-follow", items }), { status: 200 }); }, { available: true } as never);
  const tracks = await provider.fromUrl("https://youtube.com/playlist?list=PL_tracks"); assert.ok(Array.isArray(tracks)); assert.equal(tracks.length, MAX_PLAYLIST_TRACKS); assert.equal(calls, 1);
});

test("real process wrapper selects audio-only, preserves ephemeral headers, and uses fixed safe argv", async () => {
  const path = await fakeYtDlp(`if(!process.argv.includes('--no-playlist')||!process.argv.includes('--ignore-config')||process.argv.includes('--extractor-args')||process.argv.some(x=>x.includes('cookie')))process.exit(9);console.log(JSON.stringify({formats:[
    {url:'https://cdn/video',acodec:'aac',vcodec:'h264',tbr:999},
    {url:'https://cdn/audio',acodec:'opus',vcodec:'none',abr:128,http_headers:{'User-Agent':'Aria Test',Cookie:'secret'}}
  ], invoked:process.argv.slice(2)}))`);
  const resolver = new YtDlpResolver({ path, available: true }); const media = await resolver.resolve("https://youtube.com/watch?v=--exec");
  assert.equal(media.inputUrl, "https://cdn/audio"); assert.deepEqual(media.requestHeaders, { "User-Agent": "Aria Test", Cookie: "secret" });
  assert.equal("track" in media, false); resolver.shutdown();
});

test("PO-token mode requests only the documented mweb extractor client and returns ephemeral media", async () => {
  const path = await fakeYtDlp(`const i=process.argv.indexOf('--extractor-args');if(i<0||process.argv[i+1]!=='youtube:player_client=mweb'||process.argv.some(x=>x.toLowerCase().includes('cookie')))process.exit(9);console.log(JSON.stringify({url:'https://cdn/po-audio',acodec:'opus',vcodec:'none'}))`);
  const resolver = new YtDlpResolver({ path, available: true, poTokenEnabled: true, poTokenProviderAvailable: true });
  assert.equal((await resolver.resolve("https://music.youtube.com/watch?v=x")).inputUrl, "https://cdn/po-audio");
});

test("provider failure falls back exactly once without mweb or cookies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aria-ytdlp-calls-")); const calls = join(dir, "calls");
  const path = await fakeYtDlp(`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.includes('--extractor-args')){console.error('PO Token Provider unavailable token=secret-pot-value');process.exit(1)}console.log(JSON.stringify({url:'https://cdn/fallback',acodec:'opus',vcodec:'none'}))`);
  const resolver = new YtDlpResolver({ path, available: true, poTokenEnabled: true, poTokenProviderAvailable: true });
  assert.equal((await resolver.resolve("https://youtu.be/x")).inputUrl, "https://cdn/fallback");
  const invocations = (await import("node:fs/promises")).readFile(calls, "utf8").then(value => value.trim().split("\n").map(line => JSON.parse(line) as string[]));
  const args = await invocations; assert.equal(args.length, 2); assert.ok(args[0].includes("youtube:player_client=mweb")); assert.ok(!args[1].includes("--extractor-args")); assert.ok(args.flat().every(arg => !arg.toLowerCase().includes("cookie")));
});

test("private videos do not fall back and bot failures hide token material", async () => {
  let path = await fakeYtDlp(`console.error('This video is private');process.exit(1)`);
  let resolver = new YtDlpResolver({ path, available: true, poTokenEnabled: true, poTokenProviderAvailable: true });
  await assert.rejects(resolver.resolve("https://youtu.be/x"), /unavailable or private/);
  path = await fakeYtDlp(`console.error('Sign in to confirm you are not a bot po_token=VERY_SECRET_TOKEN_VALUE');process.exit(1)`);
  resolver = new YtDlpResolver({ path, available: true, poTokenEnabled: true, poTokenProviderAvailable: true });
  await assert.rejects(resolver.resolve("https://youtu.be/x"), error => error instanceof Error && /PO-token playback was unavailable or unsuccessful/.test(error.message) && !/SECRET|po_token/.test(error.message));
});

test("disabled or unavailable PO provider never adds extractor arguments", async () => {
  for (const options of [{ poTokenEnabled: false, poTokenProviderAvailable: true }, { poTokenEnabled: true, poTokenProviderAvailable: false }]) {
    const path = await fakeYtDlp(`if(process.argv.includes('--extractor-args'))process.exit(9);console.log(JSON.stringify({url:'https://cdn/normal',acodec:'opus',vcodec:'none'}))`);
    assert.equal((await new YtDlpResolver({ path, available: true, ...options }).resolve("https://youtu.be/x")).inputUrl, "https://cdn/normal");
  }
});

test("audio-containing format is a fallback and malformed JSON is contained", async () => {
  const fallback = await fakeYtDlp(`console.log(JSON.stringify({formats:[{url:'https://cdn/av',acodec:'aac',vcodec:'h264'}]}))`);
  assert.equal((await new YtDlpResolver({ path: fallback, available: true }).resolve("https://youtu.be/x")).inputUrl, "https://cdn/av");
  const malformed = await fakeYtDlp(`console.log('{bad')`);
  await assert.rejects(new YtDlpResolver({ path: malformed, available: true }).resolve("https://youtu.be/x"), /couldn't resolve/);
});

test("resolver timeout terminates the child and returns a useful error", async () => {
  const path = await fakeYtDlp(`setInterval(()=>{},1000)`); const resolver = new YtDlpResolver({ path, available: true, timeoutMs: 30 });
  await assert.rejects(resolver.resolve("https://youtu.be/x"), /too long/); resolver.shutdown();
});

test("missing and private media errors are user-friendly", async () => {
  const missing = new YtDlpResolver({ path: "/definitely/missing/yt-dlp", available: true }); await assert.rejects(missing.resolve("https://youtu.be/x"), /not installed/);
  const privateVideo = await fakeYtDlp(`console.error('This video is private');process.exit(1)`);
  await assert.rejects(new YtDlpResolver({ path: privateVideo, available: true }).resolve("https://youtu.be/x"), /unavailable or private/);
});
