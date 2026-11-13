import { ConsoleAdapter, FluxerAdapter, StoatAdapter } from "./platform.js";
import { MultiPlatformAdapter } from "./adapters/multi.js";
import type { PlatformAdapter } from "./types.js";

function token(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) { const value = env[name]?.trim(); if (value) return value; }
  return undefined;
}

export function createAdapter(env: NodeJS.ProcessEnv = process.env): PlatformAdapter {
  const platform = (env.ARIA_PLATFORM ?? "console").trim().toLowerCase();
  if (platform === "console") return new ConsoleAdapter();
  if (platform === "both") {
    const fluxer = token(env, "ARIA_FLUXER_TOKEN"), stoat = token(env, "ARIA_STOAT_TOKEN");
    const missing = [!fluxer && "ARIA_FLUXER_TOKEN", !stoat && "ARIA_STOAT_TOKEN"].filter(Boolean);
    if (missing.length) throw new Error(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required when ARIA_PLATFORM=both`);
    return new MultiPlatformAdapter([{ name: "fluxer", adapter: new FluxerAdapter(fluxer!) }, { name: "stoat", adapter: new StoatAdapter(stoat!) }]);
  }
  if (platform !== "fluxer" && platform !== "stoat") throw new Error(`Unsupported ARIA_PLATFORM "${env.ARIA_PLATFORM}". Use console, fluxer, stoat, or both.`);
  const value = platform === "fluxer" ? token(env, "ARIA_TOKEN", "ARIA_FLUXER_TOKEN") : token(env, "ARIA_TOKEN", "ARIA_STOAT_TOKEN");
  if (!value) throw new Error(`ARIA_TOKEN is required when ARIA_PLATFORM=${platform}`);
  return platform === "fluxer" ? new FluxerAdapter(value) : new StoatAdapter(value);
}
