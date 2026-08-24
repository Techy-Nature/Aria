import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { AudioFrame, type AudioSource as LiveKitAudioSource } from "@livekit/rtc-node";
import type { AudioSource } from "./types.js";

export interface Decoder { pause(): void; resume(): void; stop(): void; done: Promise<void> }
export interface FrameSink { captureFrame(frame: AudioFrame): Promise<void> }
export interface PumpStats { maxBufferedBytes: number; frames: number }
const FRAME_BYTES = 480 * 2 * 2;
function safeDecoderDetail(stderr: string) {
  return stderr.replace(/https?:\/\/\S+/gi, "[redacted-media-url]").replace(/(authorization|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]").trim();
}

/**
 * Pulls PCM only as quickly as LiveKit accepts frames. Node's Readable
 * high-water mark supplies the bounded buffer while captureFrame is pending.
 */
export async function pumpPcm(stream: Readable, sink: FrameSink, signal: AbortSignal): Promise<PumpStats> {
  let pending = Buffer.alloc(0), maxBufferedBytes = 0, frames = 0;
  for await (const value of stream) {
    if (signal.aborted) break;
    pending = Buffer.concat([pending, value as Buffer]);
    maxBufferedBytes = Math.max(maxBufferedBytes, pending.length + stream.readableLength);
    while (pending.length >= FRAME_BYTES && !signal.aborted) {
      const bytes = pending.subarray(0, FRAME_BYTES); pending = pending.subarray(FRAME_BYTES);
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      await sink.captureFrame(new AudioFrame(samples, 48000, 2, 480));
      frames++;
    }
  }
  return { maxBufferedBytes, frames };
}

export async function decodeToLiveKit(source: AudioSource, sink: LiveKitAudioSource): Promise<Decoder> {
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-re"];
  if ((source.positionSeconds ?? 0) > 0) args.push("-ss", String(source.positionSeconds));
  args.push("-i", source.inputUrl, "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1");
  const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const abort = new AbortController(); let stderr = "", manual = false;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const pumping = pumpPcm(child.stdout, sink, abort.signal);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { void pumping.then(() => code === 0 || manual ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${safeDecoderDetail(stderr) || "decoder failure"}`)), reject); });
  });
  const stop = () => { manual = true; abort.abort(); child.stdout.destroy(); if (child.exitCode === null) { child.kill("SIGCONT"); child.kill("SIGTERM"); } };
  return { pause: () => child.kill("SIGSTOP"), resume: () => child.kill("SIGCONT"), stop, done };
}
