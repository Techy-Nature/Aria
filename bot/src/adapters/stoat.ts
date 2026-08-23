import WebSocket, { type RawData } from "ws";
import type { PlatformAdapter } from "../types.js";
import { checkedJson, defaultSocketFactory, record, text, type Fetch, type MessageHandler, type SocketFactory } from "./common.js";

const API = "https://api.stoat.chat"; const EVENTS = "wss://events.stoat.chat/?version=1&format=json";

export class StoatAdapter implements PlatformAdapter {
  private socket?: WebSocket; private handler?: MessageHandler; private stopped = true; private ping?: NodeJS.Timeout; private reconnect?: NodeJS.Timeout; private attempts = 0; private selfId?: string;
  private channels = new Map<string, string>(); private voice = new Map<string, string>();
  constructor(private token: string, private fetcher: Fetch = fetch, private sockets: SocketFactory = defaultSocketFactory) {}
  async start(onMessage: MessageHandler) { this.handler = onMessage; this.stopped = false; this.connect(); }
  private connect() {
    if (this.stopped) return; console.log("[Stoat] Connecting..."); const socket = this.sockets(EVENTS); this.socket = socket;
    socket.on("open", () => { this.send({ type: "Authenticate", token: this.token }); this.ping = setInterval(() => this.send({ type: "Ping", data: Date.now() }), 30_000); });
    socket.on("message", data => this.receive(data)); socket.on("error", e => console.error(`[Stoat] WebSocket error: ${e.message}`));
    socket.on("close", (code, reason) => { this.clearPing(); if (this.socket === socket) this.socket = undefined; if (!this.stopped) { console.warn(`[Stoat] Disconnected (${code}${reason.length ? `: ${reason.toString()}` : ""}); reconnecting`); this.scheduleReconnect(); } });
  }
  private receive(raw: RawData) { try { this.handleEvent(JSON.parse(raw.toString()) as unknown); } catch (e) { console.error(`[Stoat] Invalid event: ${e instanceof Error ? e.message : String(e)}`); } }
  /** Exposed to permit protocol normalization tests without a live event server. */
  handleEvent(value: unknown) {
    const event = record(value); if (!event || typeof event.type !== "string") return;
    if (event.type === "Bulk" && Array.isArray(event.v)) { for (const child of event.v) this.handleEvent(child); return; }
    if (event.type === "Ping") { this.send({ type: "Pong", data: event.data }); return; }
    if (event.type === "Error") { console.error(`[Stoat] Protocol error: ${JSON.stringify(event.data)}`); return; }
    if (event.type === "Logout") { console.error("[Stoat] Logged out by server"); this.socket?.close(4000, "Logout"); return; }
    if (event.type === "Authenticated") { console.log("[Stoat] Authenticated"); return; }
    if (event.type === "Ready") { this.loadReady(event); this.attempts = 0; console.log(`[Stoat] Authenticated as bot (${this.selfId ?? "unknown id"})`); console.log("[Stoat] Ready"); return; }
    if (event.type === "VoiceChannelJoin") { const state = record(event.state), uid = text(state?.id), cid = text(event.id); if (uid && cid) this.voice.set(uid, cid); return; }
    if (event.type === "VoiceChannelLeave") { const uid = text(event.user); if (uid) this.voice.delete(uid); return; }
    if (event.type === "VoiceChannelMove") { const uid = text(event.user), cid = text(event.to); if (uid && cid) this.voice.set(uid, cid); return; }
    if (event.type === "Message") void this.normalizeMessage(event);
  }
  private loadReady(event: Record<string, unknown>) {
    if (Array.isArray(event.channels)) for (const item of event.channels) { const c = record(item), id = text(c?._id), server = text(c?.server); if (id && server) this.channels.set(id, server); }
    if (Array.isArray(event.users)) for (const item of event.users) { const u = record(item); if (u?.relationship === "User") this.selfId = text(u._id); }
    if (Array.isArray(event.voice_states)) for (const item of event.voice_states) { const state = record(item), cid = text(state?.id); if (cid && Array.isArray(state?.participants)) for (const p of state.participants) { const participant = record(p), uid = text(participant?.id); if (uid) this.voice.set(uid, cid); } }
  }
  private async normalizeMessage(message: Record<string, unknown>) {
    const content = text(message.content), channelId = text(message.channel), userId = text(message.author), guildId = channelId ? this.channels.get(channelId) : undefined;
    if (!content || !channelId || !guildId || !userId || userId === this.selfId || message.webhook !== undefined || !this.handler) return;
    await this.handler({ guildId, channelId, userId, voiceChannelId: this.voice.get(userId), reply: async reply => { await this.sendMessage(channelId, reply); } }, content);
  }
  private async sendMessage(channel: string, content: string) { await checkedJson(await this.fetcher(`${API}/channels/${encodeURIComponent(channel)}/messages`, { method: "POST", headers: { "X-Bot-Token": this.token, "Content-Type": "application/json" }, body: JSON.stringify({ content }) }), "Stoat"); }
  private send(event: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
  private clearPing() { if (this.ping) clearInterval(this.ping); this.ping = undefined; }
  private scheduleReconnect() { if (this.stopped || this.reconnect) return; const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5)); this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect(); }, delay); }
  async stop() { this.stopped = true; this.clearPing(); if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined; const socket = this.socket; this.socket = undefined; socket?.close(1000, "Aria shutting down"); console.log("[Stoat] Stopped"); }
}
