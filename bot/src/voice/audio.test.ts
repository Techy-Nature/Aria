import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pumpPcm } from "./audio.js";

const frameBytes = 480 * 2 * 2;
test("slow LiveKit consumption applies bounded Readable backpressure", async () => {
  let produced = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stream = new Readable({ highWaterMark: frameBytes * 2, read() { while (produced < 500 && this.push(Buffer.alloc(frameBytes))) produced++; if (produced === 500) this.push(null); } });
  const pumping = pumpPcm(stream, { captureFrame: async () => gate }, new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(produced < 20, `producer ran too far ahead: ${produced} frames`);
  release(); const stats = await pumping;
  assert.ok(stats.maxBufferedBytes < frameBytes * 20);
});

test("abort prevents buffered old frames from publishing", async () => {
  const abort = new AbortController(); let frames = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stream = Readable.from([Buffer.alloc(frameBytes * 20)]);
  const pumping = pumpPcm(stream, { captureFrame: async () => { frames++; await gate; } }, abort.signal);
  await new Promise(resolve => setTimeout(resolve, 10)); abort.abort(); release(); await pumping;
  assert.equal(frames, 1);
});
