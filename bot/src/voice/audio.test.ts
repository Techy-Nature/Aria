import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createPcmFrame, PCM_FRAME_BYTES, PCM_FRAME_SAMPLES, PCM_SAMPLE_RATE, PCM_SAMPLES_PER_CHANNEL, pumpPcm } from "./audio.js";

const frameBytes = PCM_FRAME_BYTES;

function pattern(channels: number) {
  const pcm = Buffer.alloc(PCM_SAMPLES_PER_CHANNEL * channels * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE((i * 97 % 65536) - 32768, i * 2);
  return pcm;
}

test("stereo frame has exact byte/sample counts, metadata, interleaving, and copied samples", () => {
  const pcm = pattern(2);
  assert.equal(pcm.length, 1920);
  const frame = createPcmFrame(pcm);
  assert.equal(frame.sampleRate, 48000);
  assert.equal(frame.channels, 2);
  assert.equal(frame.samplesPerChannel, 480);
  assert.equal(frame.data.length, 960);
  assert.equal(frame.data.length, PCM_FRAME_SAMPLES);
  assert.deepEqual([...frame.data], Array.from({ length: 960 }, (_, i) => pcm.readInt16LE(i * 2)));
  const left = frame.data[20], right = frame.data[21];
  pcm.writeInt16LE(0, 40); pcm.writeInt16LE(0, 42);
  assert.equal(frame.data[20], left); assert.equal(frame.data[21], right);
});

test("mono frame has exact metadata and copied sample count", () => {
  const pcm = pattern(1); const frame = createPcmFrame(pcm, 1);
  assert.equal(pcm.length, 960);
  assert.equal(frame.sampleRate, PCM_SAMPLE_RATE);
  assert.equal(frame.channels, 1);
  assert.equal(frame.samplesPerChannel, PCM_SAMPLES_PER_CHANNEL);
  assert.equal(frame.data.length, 480);
});

test("FFmpeg pipeline preserves deterministic 48 kHz s16le stereo PCM", async () => {
  const pcm = pattern(2);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(48000 * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1"]);
  const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stdin.end(wav);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0); assert.deepEqual(Buffer.concat(chunks), pcm);
});

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
