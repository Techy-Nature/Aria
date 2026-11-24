import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkSocksRoute, socksProxy } from "./routecheck.js";
import { lastSteps, YtDlpResolver } from "./ytdlp.js";

async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as { port: number }).port; }
async function fakeYtDlp(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "aria-route-")); const path = join(dir, "yt-dlp");
  await writeFile(path, `#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log('test'); else { ${body} }\n`); await chmod(path, 0o755); return { path, dir };
}
const quiet = () => { const log = console.log, warn = console.warn, lines: string[] = []; console.log = (m: string) => lines.push(m); console.warn = (m: string) => lines.push(m); return { lines, restore: () => { console.log = log; console.warn = warn; } }; };

test("socksProxy only accepts plain SOCKS5 proxies", () => {
  assert.deepEqual(socksProxy("socks5h://127.0.0.1:1055"), { host: "127.0.0.1", port: 1055 });
  assert.deepEqual(socksProxy("socks5://localhost"), { host: "localhost", port: 1080 });
  assert.equal(socksProxy("http://127.0.0.1:8080"), undefined);
  assert.equal(socksProxy("socks5h://u:p@127.0.0.1:1055"), undefined);
  assert.equal(socksProxy(undefined), undefined); assert.equal(socksProxy("nope"), undefined);
});

test("a SOCKS failure reply is reported", async () => {
  const server = createServer(socket => socket.on("data", data => socket.write(data[0] === 5 && data.length === 3 ? Buffer.from([5, 0]) : Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]))));
  const port = await listen(server);
  try { const result = await checkSocksRoute({ host: "127.0.0.1", port }, "www.youtube.com", 443, 2_000); assert.equal(result.ok, false); assert.match(!result.ok ? result.reason : "", /host unreachable/); }
  finally { server.close(); }
});

test("a SOCKS 'ok' that never carries data counts as a failure", async () => {
  // Like Tailscale answering ok while the exit node passes nothing through.
  const server = createServer(socket => socket.on("data", data => { if (data[0] === 5 && data.length === 3) socket.write(Buffer.from([5, 0])); else if (data[0] === 5) socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); }));
  const port = await listen(server);
  try { const result = await checkSocksRoute({ host: "127.0.0.1", port }, "www.youtube.com", 443, 300); assert.equal(result.ok, false); assert.match(!result.ok ? result.reason : "", /no answer/); }
  finally { server.close(); }
});

test("an unreachable proxy is reported", async () => {
  const server = createServer(); const port = await listen(server); server.close();
  const result = await checkSocksRoute({ host: "127.0.0.1", port }, "www.youtube.com", 443, 2_000);
  assert.equal(result.ok, false); assert.match(!result.ok ? result.reason : "", /proxy connection failed|closed/);
});

test("a failed route check stops playback fast without running yt-dlp", async () => {
  const { path, dir } = await fakeYtDlp(`require('node:fs').writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]),'calls'),'x');setInterval(()=>{},1000)`);
  const out = quiet(); let checks = 0;
  try {
    const resolver = new YtDlpResolver({ path, available: true, timeoutMs: 5_000, routeCheck: async () => { checks++; return { ok: false, ms: 12, reason: "no answer within 10s" }; } });
    const started = Date.now();
    await assert.rejects(resolver.resolve("https://youtu.be/x"), /home connection/);
    assert.ok(Date.now() - started < 1_000); assert.equal(checks, 1);
    assert.ok(out.lines.some(line => /route to YouTube through YTDLP_PROXY failed after 12 ms: no answer/.test(line)));
    await assert.rejects(readFile(join(dir, "calls")));
  } finally { out.restore(); }
});

test("a passed route check is trusted for a minute", async () => {
  const { path } = await fakeYtDlp(`console.log(JSON.stringify({url:'https://cdn/a',acodec:'opus',vcodec:'none'}))`);
  const out = quiet(); let checks = 0;
  try {
    const resolver = new YtDlpResolver({ path, available: true, routeCheck: async () => { checks++; return { ok: true, ms: 80 }; } });
    await resolver.resolve("https://youtu.be/x"); await resolver.resolve("https://youtu.be/y");
    assert.equal(checks, 1);
  } finally { out.restore(); }
});

test("a timeout logs yt-dlp's last output, redacted", async () => {
  const { path } = await fakeYtDlp(`console.error('[debug] Proxy map: {"all": "socks5h://alice:hunter2@127.0.0.1:1055"}');console.error('[youtube] x: Downloading webpage');setInterval(()=>{},1000)`);
  const out = quiet();
  try {
    const resolver = new YtDlpResolver({ path, available: true, timeoutMs: 300, routeCheck: null });
    await assert.rejects(resolver.resolve("https://youtu.be/x"), /too long/); resolver.shutdown();
    const line = out.lines.find(item => item.includes("extraction timed out")) ?? "";
    assert.match(line, /standard/); assert.match(line, /last output: .*Downloading webpage/); assert.ok(!/hunter2|alice/.test(line));
  } finally { out.restore(); }
});

test("lastSteps keeps the last lines only", () => {
  assert.equal(lastSteps("a\n\nb\nc\nd\n"), "b | c | d"); assert.equal(lastSteps(""), undefined);
});

test("yt-dlp runs verbose for extraction so timeouts have something to show", async () => {
  const { path } = await fakeYtDlp(`if(!process.argv.includes('--verbose'))process.exit(9);console.error('[debug] region: US, private video check');console.log(JSON.stringify({url:'https://cdn/v',acodec:'opus',vcodec:'none'}))`);
  const out = quiet();
  try { assert.equal((await new YtDlpResolver({ path, available: true, routeCheck: null }).resolve("https://youtu.be/x")).inputUrl, "https://cdn/v"); }
  finally { out.restore(); }
});

test("debug lines never decide the failure kind", async () => {
  const { path } = await fakeYtDlp(`console.error('[debug] geo bypass region: US');console.error('ERROR: [youtube] x: Some odd failure');process.exit(1)`);
  const out = quiet();
  try { await assert.rejects(new YtDlpResolver({ path, available: true, routeCheck: null }).resolve("https://youtu.be/x"), /couldn't resolve/); }
  finally { out.restore(); }
});
