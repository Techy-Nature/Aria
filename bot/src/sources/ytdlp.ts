import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { UnplayableSourceError, ProviderUnavailableError } from "./types.js";

const HOSTS = new Set(["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"]);
const MAX_OUTPUT = 2 * 1024 * 1024;
type Format = { url?: unknown; acodec?: unknown; vcodec?: unknown; abr?: unknown; tbr?: unknown; ext?: unknown; http_headers?: unknown };
type Output = Format & { formats?: unknown; http_headers?: unknown };

export interface YtDlpResult { inputUrl: string; requestHeaders?: Record<string, string> }
export interface YtDlpOptions { path?: string; timeoutMs?: number; available?: boolean }

export function validateYtDlpUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new UnplayableSourceError("That is not a valid supported media URL."); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !HOSTS.has(url.hostname.toLowerCase()))
    throw new UnplayableSourceError("That website is not supported for yt-dlp playback.");
  return url;
}

function headers(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const safe: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (/^[A-Za-z0-9-]+$/.test(key) && typeof item === "string" && !/[\r\n]/.test(item)) safe[key] = item;
  return Object.keys(safe).length ? safe : undefined;
}
function playable(format: Format) { return typeof format.url === "string" && /^https?:\/\//.test(format.url) && typeof format.acodec === "string" && format.acodec !== "none"; }
function score(format: Format) {
  const audioOnly = format.vcodec === "none" ? 1_000_000 : 0;
  const compatibility = ["m4a", "mp4", "webm", "opus"].includes(String(format.ext)) ? 10_000 : 0;
  return audioOnly + compatibility + Number(format.abr ?? format.tbr ?? 0);
}

export class YtDlpResolver {
  readonly executable: string; readonly available: boolean;
  private readonly timeoutMs: number; private readonly children = new Set<ChildProcess>();
  constructor(options: YtDlpOptions = {}) {
    this.executable = options.path ?? process.env.YTDLP_PATH ?? "yt-dlp"; this.timeoutMs = options.timeoutMs ?? 20_000;
    this.available = options.available ?? spawnSync(this.executable, ["--version"], { shell: false, stdio: "ignore", timeout: 3_000 }).status === 0;
  }
  async resolve(input: string): Promise<YtDlpResult> {
    const url = validateYtDlpUrl(input);
    if (!this.available) throw new ProviderUnavailableError("YouTube playback is unavailable because yt-dlp is not installed.");
    const args = ["--ignore-config", "--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download", url.toString()];
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] }); this.children.add(child);
      let stdout = "", stderr = "", timedOut = false, settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); this.children.delete(child); error ? reject(error) : resolve(stdout); };
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1_000).unref(); }, this.timeoutMs);
      child.stdout.on("data", chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > MAX_OUTPUT) { child.kill("SIGTERM"); finish(new Error("yt-dlp output exceeded the safe limit")); } });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
      child.once("error", error => finish((error as NodeJS.ErrnoException).code === "ENOENT" ? new ProviderUnavailableError("YouTube playback is unavailable because yt-dlp is not installed.") : error));
      child.once("close", code => {
        if (timedOut) return finish(new UnplayableSourceError("YouTube took too long to respond."));
        if (code === 0) return finish();
        const detail = stderr.toLowerCase();
        if (/private|unavailable|removed/.test(detail)) return finish(new UnplayableSourceError("That YouTube video is unavailable or private."));
        if (/sign in|login|age.restrict|authentication/.test(detail)) return finish(new UnplayableSourceError("That YouTube video requires authentication and Aria cannot access it."));
        if (/geo|country|region/.test(detail)) return finish(new UnplayableSourceError("That video is not available from Aria's server region."));
        finish(new UnplayableSourceError("I couldn't resolve that YouTube audio stream."));
      });
    });
    let data: Output; try { data = JSON.parse(output) as Output; } catch { throw new UnplayableSourceError("I couldn't resolve that YouTube audio stream."); }
    const formats = Array.isArray(data.formats) ? (data.formats as Format[]).filter(playable).sort((a, b) => score(b) - score(a)) : [];
    const selected = formats[0] ?? (playable(data) ? data : undefined);
    if (!selected || typeof selected.url !== "string") throw new UnplayableSourceError("I couldn't find a playable audio stream for that source.");
    return { inputUrl: selected.url, requestHeaders: headers(selected.http_headers) ?? headers(data.http_headers) };
  }
  shutdown() { for (const child of this.children) if (child.exitCode === null) child.kill("SIGTERM"); this.children.clear(); }
}
