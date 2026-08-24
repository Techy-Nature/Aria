import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { AudioFrame, type AudioSource as LiveKitAudioSource } from "@livekit/rtc-node";
import type { AudioSource } from "./types.js";

export interface Decoder { pause(): void; resume(): void; stop(): void; done: Promise<void> }
export interface FrameSink { captureFrame(frame: AudioFrame): Promise<void>; clearQueue?(): void }
export interface PumpStats { maxBufferedBytes: number; frames: number }
export const PCM_SAMPLE_RATE = 48000;
export const PCM_CHANNELS = 2;
export const PCM_SAMPLES_PER_CHANNEL = 480;
export const PCM_SAMPLE_BYTES = 2;
export const PCM_FRAME_SAMPLES = PCM_SAMPLES_PER_CHANNEL * PCM_CHANNELS;
export const PCM_FRAME_BYTES = PCM_FRAME_SAMPLES * PCM_SAMPLE_BYTES;
function safeDecoderDetail(stderr: string) {
  return stderr.replace(/https?:\/\/\S+/gi, "[redacted-media-url]").replace(/(authorization|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]").trim();
}

/** Copy one 10 ms, signed 16-bit little-endian, interleaved PCM block into LiveKit-owned memory. */
export function createPcmFrame(bytes: Buffer, channels = PCM_CHANNELS): AudioFrame {
  const expectedSamples = PCM_SAMPLES_PER_CHANNEL * channels;
  const expectedBytes = expectedSamples * PCM_SAMPLE_BYTES;
  if (bytes.length !== expectedBytes) throw new RangeError(`PCM frame must contain exactly ${expectedBytes} bytes`);

  const frame = AudioFrame.create(PCM_SAMPLE_RATE, channels, PCM_SAMPLES_PER_CHANNEL);
  // Do not give LiveKit a view into Buffer's pooled/reused backing ArrayBuffer. In
  // particular, AudioFrame's FFI pointer is based on data.buffer and cannot retain
  // the byteOffset of such a view. Explicit LE reads also document FFmpeg's format.
  for (let sample = 0; sample < expectedSamples; sample++) {
    frame.data[sample] = bytes.readInt16LE(sample * PCM_SAMPLE_BYTES);
  }
  return frame;
}

/**
 * Pulls PCM only as quickly as LiveKit accepts frames. Node's Readable
 * high-water mark supplies the bounded buffer while captureFrame is pending.
 */
export async function pumpPcm(stream: Readable, sink: FrameSink, signal: AbortSignal, channels = PCM_CHANNELS): Promise<PumpStats> {
  const frameBytes = PCM_SAMPLES_PER_CHANNEL * channels * PCM_SAMPLE_BYTES;
  let pending = Buffer.alloc(0), maxBufferedBytes = 0, frames = 0;
  for await (const value of stream) {
    if (signal.aborted) break;
    pending = Buffer.concat([pending, value as Buffer]);
    maxBufferedBytes = Math.max(maxBufferedBytes, pending.length + stream.readableLength);
    while (pending.length >= frameBytes && !signal.aborted) {
      const bytes = pending.subarray(0, frameBytes); pending = pending.subarray(frameBytes);
      await sink.captureFrame(createPcmFrame(bytes, channels));
      frames++;
    }
  }
  return { maxBufferedBytes, frames };
}

export async function decodeToLiveKit(source: AudioSource, sink: LiveKitAudioSource): Promise<Decoder> {
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-re"];
  if ((source.positionSeconds ?? 0) > 0) args.push("-ss", String(source.positionSeconds));
  if (source.requestHeaders && Object.keys(source.requestHeaders).length) {
    // Values originate only in a provider response. Reject line breaks so a
    // malformed extractor response cannot inject additional protocol headers.
    const headers = Object.entries(source.requestHeaders)
      .filter(([name, value]) => /^[A-Za-z0-9-]+$/.test(name) && !/[\r\n]/.test(value))
      .map(([name, value]) => `${name}: ${value}\r\n`).join("");
    if (headers) args.push("-headers", headers);
  }
  args.push("-i", source.inputUrl, "-vn", "-ac", String(PCM_CHANNELS), "-ar", String(PCM_SAMPLE_RATE), "-f", "s16le", "pipe:1");
  const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const abort = new AbortController(); let stderr = "", manual = false;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const pumping = pumpPcm(child.stdout, sink, abort.signal);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { void pumping.then(() => code === 0 || manual ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${safeDecoderDetail(stderr) || "decoder failure"}`)), reject); });
  });
  const stop = () => {
    manual = true; abort.abort(); child.stdout.destroy(); sink.clearQueue();
    // A capture already awaiting the native source can finish after the first
    // clear; clear once more after the pump exits so skipped PCM cannot leak.
    void pumping.finally(() => sink.clearQueue());
    if (child.exitCode === null) { child.kill("SIGCONT"); child.kill("SIGTERM"); }
  };
  return { pause: () => child.kill("SIGSTOP"), resume: () => child.kill("SIGCONT"), stop, done };
}
