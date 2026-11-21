import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { FluxerAdapter } from "./fluxer.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN; sent: Array<{ op: number; d: unknown }> = []; terminated = false;
  constructor(readonly url: string) { super(); }
  send(value: string) { this.sent.push(JSON.parse(value) as { op: number; d: unknown }); }
  close(code = 1000, reason = "") { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit("close", code, Buffer.from(reason)); }
  terminate() { this.terminated = true; this.close(1006); }
  ops() { return this.sent.map(packet => packet.op); }
}

/** An adapter wired to fake sockets; `gateway()` feeds a packet to the newest socket as if Fluxer sent it. */
function harness() {
  const sockets: FakeSocket[] = [];
  const adapter = new FluxerAdapter("secret", fetch, url => { const socket = new FakeSocket(url); sockets.push(socket); return socket as never; }, { connectTimeoutMs: 15_000, random: () => 0 });
  const latest = () => sockets.at(-1)!;
  const gateway = (packet: unknown) => latest().emit("message", Buffer.from(JSON.stringify(packet)));
  const hello = () => gateway({ op: 10, d: { heartbeat_interval: 41_250 } });
  const ready = (extra: Record<string, unknown> = {}) => gateway({ op: 0, s: 1, t: "READY", d: { session_id: "session-1", user: { id: "self", username: "Aria" }, ...extra } });
  return { adapter, sockets, latest, gateway, hello, ready };
}

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const method of ["log", "warn", "error"] as const) mock.method(console, method, (...args: unknown[]) => { logs.push(args.join(" ")); });
});
afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

test("a dropped connection reconnects at once and resumes with the last sequence", async () => {
  const { adapter, sockets, latest, gateway, hello, ready } = harness();
  await adapter.start(async () => {});
  hello(); ready();
  gateway({ op: 0, s: 7, t: "MESSAGE_CREATE", d: {} });
  latest().close(1006);
  mock.timers.tick(0);
  assert.equal(sockets.length, 2);
  hello();
  assert.deepEqual(latest().sent.at(-1), { op: 6, d: { token: "secret", session_id: "session-1", seq: 7 } });
  gateway({ op: 0, s: 8, t: "RESUMED", d: {} });
  assert.ok(logs.some(line => line.startsWith("[Fluxer] Ready (session resumed after")));
  await adapter.stop();
});

test("close codes 4007 and 4009 start a new session instead of a doomed resume", async () => {
  for (const code of [4007, 4009]) {
    const { adapter, latest, hello, ready } = harness();
    await adapter.start(async () => {});
    hello(); ready();
    latest().close(code, "Invalid sequence");
    mock.timers.tick(0);
    hello();
    assert.equal(latest().sent.at(-1)?.op, 2, `code ${code} should IDENTIFY`);
    await adapter.stop();
  }
});

test("invalid session: d=false identifies fresh after a short pause, d=true resumes", async () => {
  const { adapter, sockets, latest, gateway, hello, ready } = harness();
  await adapter.start(async () => {});
  hello(); ready();
  gateway({ op: 9, d: false });
  mock.timers.tick(999); assert.equal(sockets.length, 1);
  mock.timers.tick(1); assert.equal(sockets.length, 2);
  hello(); assert.equal(latest().sent.at(-1)?.op, 2);
  ready();
  gateway({ op: 9, d: true });
  mock.timers.tick(1_000); hello();
  assert.equal(latest().sent.at(-1)?.op, 6);
  await adapter.stop();
});

test("a missed heartbeat ACK drops the zombie connection and resumes", async () => {
  const { adapter, sockets, latest, gateway, hello, ready } = harness();
  await adapter.start(async () => {});
  hello(); ready();
  mock.timers.tick(0); // first heartbeat (jitter is 0 in tests)
  assert.equal(latest().sent.at(-1)?.op, 1);
  gateway({ op: 11 });
  mock.timers.tick(41_250); // second heartbeat, acknowledged
  gateway({ op: 11 });
  mock.timers.tick(41_250); // third heartbeat, never acknowledged
  assert.equal(sockets[0].terminated, false);
  mock.timers.tick(41_250);
  assert.equal(sockets[0].terminated, true);
  mock.timers.tick(0);
  assert.equal(sockets.length, 2);
  hello(); assert.equal(latest().sent.at(-1)?.op, 6);
  await adapter.stop();
});

test("a connection that never reaches HELLO is abandoned and retried", async () => {
  const { adapter, sockets, hello } = harness();
  await adapter.start(async () => {});
  mock.timers.tick(14_999); assert.equal(sockets[0].terminated, false);
  mock.timers.tick(1); assert.equal(sockets[0].terminated, true);
  mock.timers.tick(0); assert.equal(sockets.length, 2);
  hello(); mock.timers.tick(15_000); assert.equal(sockets[1].terminated, false);
  await adapter.stop();
});

test("retries after the first back off with growing delays", async () => {
  const { adapter, sockets, latest } = harness();
  await adapter.start(async () => {});
  latest().close(1006); mock.timers.tick(0); assert.equal(sockets.length, 2);
  latest().close(1006); mock.timers.tick(999); assert.equal(sockets.length, 2); mock.timers.tick(1); assert.equal(sockets.length, 3);
  latest().close(1006); mock.timers.tick(1_999); assert.equal(sockets.length, 3); mock.timers.tick(1); assert.equal(sockets.length, 4);
  await adapter.stop();
});

test("fatal close codes stop reconnecting; rate limiting waits a minute", async () => {
  const fatal = harness();
  await fatal.adapter.start(async () => {});
  fatal.hello(); fatal.ready();
  fatal.latest().close(4004, "Authentication failed");
  mock.timers.tick(120_000);
  assert.equal(fatal.sockets.length, 1);
  assert.ok(logs.some(line => line.includes("not reconnecting")));
  await fatal.adapter.stop();

  const limited = harness();
  await limited.adapter.start(async () => {});
  limited.hello(); limited.ready();
  limited.latest().close(4008, "Rate limited");
  mock.timers.tick(59_999); assert.equal(limited.sockets.length, 1);
  mock.timers.tick(1); assert.equal(limited.sockets.length, 2);
  await limited.adapter.stop();
});

test("resumes through READY's resume_gateway_url and falls back to the main gateway if it fails", async () => {
  const { adapter, sockets, latest, hello, ready } = harness();
  await adapter.start(async () => {});
  hello(); ready({ resume_gateway_url: "wss://resume.example.test" });
  latest().close(1006); mock.timers.tick(0);
  assert.equal(sockets[1].url, "wss://resume.example.test/?v=1&encoding=json");
  latest().close(1006); // failed before HELLO
  mock.timers.tick(2_000);
  assert.equal(sockets[2].url, "wss://gateway.fluxer.app/?v=1&encoding=json");
  hello(); assert.equal(latest().sent.at(-1)?.op, 6);
  await adapter.stop();
});

test("ignores a resume_gateway_url that is not wss", async () => {
  const { adapter, sockets, latest, hello, ready } = harness();
  await adapter.start(async () => {});
  hello(); ready({ resume_gateway_url: "http://insecure.example.test" });
  latest().close(1006); mock.timers.tick(0);
  assert.equal(sockets[1].url, "wss://gateway.fluxer.app/?v=1&encoding=json");
  await adapter.stop();
});

test("stop cancels a pending reconnect", async () => {
  const { adapter, sockets, latest } = harness();
  await adapter.start(async () => {});
  latest().close(1006);
  await adapter.stop();
  mock.timers.tick(60_000);
  assert.equal(sockets.length, 1);
});
