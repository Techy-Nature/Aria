import { ConsoleAdapter, FluxerAdapter, StoatAdapter } from "./platform.js";
import type { PlatformAdapter } from "./types.js";

export function createAdapter(env: NodeJS.ProcessEnv = process.env): PlatformAdapter {
  const platform = (env.ARIA_PLATFORM ?? "console").trim().toLowerCase();
  if (platform === "console") return new ConsoleAdapter();
  if (platform !== "fluxer" && platform !== "stoat") throw new Error(`Unsupported ARIA_PLATFORM "${env.ARIA_PLATFORM}". Use console, fluxer, or stoat.`);
  const token = env.ARIA_TOKEN?.trim();
  if (!token) throw new Error(`ARIA_TOKEN is required when ARIA_PLATFORM=${platform}`);
  return platform === "fluxer" ? new FluxerAdapter(token) : new StoatAdapter(token);
}
