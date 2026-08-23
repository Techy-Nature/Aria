import WebSocket from "ws";
import type { CommandContext } from "../types.js";

export type MessageHandler = (ctx: CommandContext, content: string) => Promise<void>;
export type Fetch = typeof fetch;
export type SocketFactory = (url: string) => WebSocket;
export const defaultSocketFactory: SocketFactory = url => new WebSocket(url);

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function checkedJson(response: Response, platform: string): Promise<unknown> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`${platform} REST ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return response.status === 204 ? undefined : response.json();
}
