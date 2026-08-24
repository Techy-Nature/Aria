import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { YtDlpResolver, validateYtDlpUrl } from "./ytdlp.js";
import { YouTubeProvider } from "./youtube.js";

async function fakeYtDlp(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "aria-ytdlp-")); const path = join(dir, "yt-dlp");
  await writeFile(path, `#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log('test'); else ${body}\n`); await chmod(path, 0o755); return path;
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
  const tracks = await provider.fromUrl("https://www.youtube.com/watch?v=selected&list=PL_test"); assert.ok(Array.isArray(tracks));
  assert.deepEqual(tracks.map(track => track.providerId), ["one", "two"]); assert.ok(tracks.every(track => track.playlistId === "PL_test" && track.playable));
  assert.equal(tracks[0].artist, "Artist"); assert.equal(tracks[0].url, "https://www.youtube.com/watch?v=one"); assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("maxResults"), "50"); assert.equal(requests[1].searchParams.get("pageToken"), "next");
});

test("real process wrapper selects audio-only, preserves ephemeral headers, and uses fixed safe argv", async () => {
  const path = await fakeYtDlp(`if(!process.argv.includes('--no-playlist')||!process.argv.includes('--ignore-config')||process.argv.length!==8)process.exit(9);console.log(JSON.stringify({formats:[
    {url:'https://cdn/video',acodec:'aac',vcodec:'h264',tbr:999},
    {url:'https://cdn/audio',acodec:'opus',vcodec:'none',abr:128,http_headers:{'User-Agent':'Aria Test',Cookie:'secret'}}
  ], invoked:process.argv.slice(2)}))`);
  const resolver = new YtDlpResolver({ path, available: true }); const media = await resolver.resolve("https://youtube.com/watch?v=--exec");
  assert.equal(media.inputUrl, "https://cdn/audio"); assert.deepEqual(media.requestHeaders, { "User-Agent": "Aria Test", Cookie: "secret" });
  assert.equal("track" in media, false); resolver.shutdown();
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
