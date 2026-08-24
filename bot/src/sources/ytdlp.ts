import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { UnplayableSourceError, ProviderUnavailableError } from "./types.js";

const HOSTS = new Set(["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"]);
const MAX_OUTPUT = 2 * 1024 * 1024;
const BASE_ARGS = ["--ignore-config", "--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download"];
const PO_ARGS = ["--extractor-args", "youtube:player_client=mweb"];
type Format = { url?: unknown; acodec?: unknown; vcodec?: unknown; abr?: unknown; tbr?: unknown; ext?: unknown; http_headers?: unknown };
type Output = Format & { formats?: unknown; http_headers?: unknown };
type FailureKind = "private" | "geo" | "bot" | "provider" | "timeout" | "generic";

export interface YtDlpResult { inputUrl: string; requestHeaders?: Record<string, string> }
export interface YtDlpOptions { path?: string; timeoutMs?: number; available?: boolean; poTokenEnabled?: boolean; poTokenProviderAvailable?: boolean }

class ResolutionFailure extends Error { constructor(readonly kind: FailureKind) { super(kind); } }

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
function enabled(value: string | undefined) { return /^(1|true|yes)$/i.test(value ?? ""); }
function classify(stderr: string): FailureKind {
  const detail = stderr.toLowerCase();
  if (/private video|video is private|video unavailable|has been removed|removed by/.test(detail)) return "private";
  if (/not available in your country|geo.?restrict|blocked in your country|region/.test(detail)) return "geo";
  if (/po token provider|pot provider|token provider|failed to generate.*po.?token|po.?token.*(missing|unavailable|failed|error)/.test(detail)) return "provider";
  if (/sign in to confirm|not a bot|bot.?challenge|login required|authentication required/.test(detail)) return "bot";
  return "generic";
}
function sanitized(stderr: string) {
  return stderr.replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\b(po_?token|pot|token|visitor_?data|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED]").trim().slice(-1000);
}
function detectProvider(): boolean {
  // Package discovery is local-only and does not contact YouTube. yt-dlp loads this
  // package through its standard plugin namespace on the next extraction.
  const check = spawnSync("python3", ["-c", "import importlib.metadata as m; m.version('bgutil-ytdlp-pot-provider')"], { shell: false, stdio: "ignore", timeout: 3_000 });
  return check.status === 0;
}

export class YtDlpResolver {
  readonly executable: string; readonly available: boolean; readonly poTokenEnabled: boolean; readonly poTokenProviderAvailable: boolean;
  private readonly timeoutMs: number; private readonly children = new Set<ChildProcess>();
  constructor(options: YtDlpOptions = {}) {
    this.executable = options.path ?? process.env.YTDLP_PATH ?? "yt-dlp"; this.timeoutMs = options.timeoutMs ?? 20_000;
    this.available = options.available ?? spawnSync(this.executable, ["--version"], { shell: false, stdio: "ignore", timeout: 3_000 }).status === 0;
    this.poTokenEnabled = options.poTokenEnabled ?? enabled(process.env.YTDLP_PO_TOKEN_ENABLED);
    this.poTokenProviderAvailable = options.poTokenProviderAvailable ?? (this.poTokenEnabled && this.available && detectProvider());
    if (this.available) console.log("[Sources/yt-dlp] available");
    else console.warn("[Sources/yt-dlp] unavailable");
    if (this.poTokenEnabled && this.poTokenProviderAvailable) console.log("[Sources/yt-dlp] PO token provider available");
    else if (this.poTokenEnabled) console.warn("[Sources/yt-dlp] PO token provider unavailable; using normal resolver");
  }
  async resolve(input: string): Promise<YtDlpResult> {
    const url = validateYtDlpUrl(input);
    if (!this.available) throw new ProviderUnavailableError("YouTube playback is unavailable because yt-dlp is not installed.");
    let poFailed = false;
    if (this.poTokenEnabled && this.poTokenProviderAvailable) {
      try { return this.parse(await this.run(url, true)); }
      catch (error) {
        if (!(error instanceof ResolutionFailure)) throw error;
        if (error.kind === "private" || error.kind === "geo" || error.kind === "timeout") throw this.publicError(error.kind, true);
        if (error.kind !== "provider" && error.kind !== "bot") throw this.publicError(error.kind, true);
        poFailed = true;
      }
    } else if (this.poTokenEnabled) poFailed = true;
    try { return this.parse(await this.run(url, false)); }
    catch (error) {
      if (!(error instanceof ResolutionFailure)) throw error;
      if (error.kind === "bot" && poFailed) throw new UnplayableSourceError("YouTube blocked playback from Aria's server. PO-token playback was unavailable or unsuccessful.");
      throw this.publicError(error.kind, false);
    }
  }
  private publicError(kind: FailureKind, poAttempt: boolean): UnplayableSourceError {
    if (kind === "private") return new UnplayableSourceError("That YouTube video is unavailable or private.");
    if (kind === "geo") return new UnplayableSourceError("That video is not available from Aria's server region.");
    if (kind === "timeout") return new UnplayableSourceError("YouTube took too long to respond.");
    if (kind === "bot") return new UnplayableSourceError(poAttempt ? "YouTube blocked playback from Aria's server. The PO-token provider could not complete this request." : "YouTube blocked playback from Aria's server.");
    if (kind === "provider") return new UnplayableSourceError("YouTube PO-token playback is unavailable because its provider could not start.");
    return new UnplayableSourceError("I couldn't resolve that YouTube audio stream.");
  }
  private run(url: URL, poToken: boolean): Promise<string> {
    const args = [...BASE_ARGS, ...(poToken ? PO_ARGS : []), url.toString()];
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] }); this.children.add(child);
      let stdout = "", stderr = "", timedOut = false, outputExceeded = false, settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); this.children.delete(child); error ? reject(error) : resolve(stdout); };
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1_000).unref(); }, this.timeoutMs);
      child.stdout.on("data", chunk => { if (outputExceeded) return; stdout += chunk; if (Buffer.byteLength(stdout) > MAX_OUTPUT) { outputExceeded = true; stdout = ""; child.stdout.destroy(); child.kill("SIGTERM"); setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1_000).unref(); } });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
      child.once("error", error => finish((error as NodeJS.ErrnoException).code === "ENOENT" ? new ProviderUnavailableError("YouTube playback is unavailable because yt-dlp is not installed.") : error));
      child.once("close", code => {
        if (timedOut) return finish(new ResolutionFailure("timeout"));
        if (outputExceeded) return finish(new ResolutionFailure("generic"));
        if (code === 0) return finish();
        const safe = sanitized(stderr); if (safe) console.warn(`[Sources/yt-dlp] extraction failed (${poToken ? "PO token" : "standard"}): ${safe}`);
        finish(new ResolutionFailure(classify(stderr)));
      });
    });
  }
  private parse(output: string): YtDlpResult {
    let data: Output; try { data = JSON.parse(output) as Output; } catch { throw new UnplayableSourceError("I couldn't resolve that YouTube audio stream."); }
    const formats = Array.isArray(data.formats) ? (data.formats as Format[]).filter(playable).sort((a, b) => score(b) - score(a)) : [];
    const selected = formats[0] ?? (playable(data) ? data : undefined);
    if (!selected || typeof selected.url !== "string") throw new UnplayableSourceError("I couldn't find a playable audio stream for that source.");
    return { inputUrl: selected.url, requestHeaders: headers(selected.http_headers) ?? headers(data.http_headers) };
  }
  shutdown() { for (const child of this.children) if (child.exitCode === null) child.kill("SIGTERM"); this.children.clear(); }
}
