import { spawn } from "node:child_process";
import type { AudioSource as LiveKitAudioSource } from "@livekit/rtc-node";
import type { AudioSource } from "./types.js";

export interface Decoder { pause(): void; resume(): void; stop(): void; done: Promise<void> }
export function validateAudioSource(source: AudioSource): URL {
  let url: URL;
  try { url = new URL(source.track.url); } catch { throw new Error("This track does not have a playable URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) audio sources are supported.");
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)) throw new Error("YouTube search results are metadata only; provide a direct, authorized media URL.");
  return url;
}

export async function decodeToLiveKit(source: AudioSource, sink: LiveKitAudioSource): Promise<Decoder> {
  const url = validateAudioSource(source);
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin"];
  if ((source.positionSeconds ?? 0) > 0) args.push("-ss", String(source.positionSeconds));
  args.push("-i", url.toString(), "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1");
  const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", buffer = Buffer.alloc(0), manual = false;
  const frameBytes = 480 * 2 * 2;
  let chain = Promise.resolve();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= frameBytes) {
      const bytes = buffer.subarray(0, frameBytes); buffer = buffer.subarray(frameBytes);
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      chain = chain.then(async () => { const { AudioFrame } = await import("@livekit/rtc-node"); await sink.captureFrame(new AudioFrame(samples, 48000, 2, 480)); });
    }
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { void chain.then(() => code === 0 || manual ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim() || "decoder failure"}`))); });
  });
  return { pause: () => child.kill("SIGSTOP"), resume: () => child.kill("SIGCONT"), stop: () => { manual = true; if (child.exitCode === null) child.kill("SIGTERM"); }, done };
}
