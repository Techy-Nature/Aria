import WebSocket, { type RawData } from "ws";
import type { PlatformAdapter } from "../types.js";
import { checkedJson, defaultSocketFactory, record, text, type Fetch, type MessageHandler, type SocketFactory } from "./common.js";
import { FluxerVoiceTransport, type FluxerVoiceGateway } from "../voice/fluxer.js";
import type { VoiceCredentials } from "../voice/livekit.js";

const API = "https://api.fluxer.app/v1";
const GATEWAY = "wss://gateway.fluxer.app/?v=1&encoding=json";

/** Fluxer gateway adapter based on the current fluxerapp/fluxer gateway opcodes. */
export class FluxerAdapter implements PlatformAdapter, FluxerVoiceGateway {
  readonly voice: FluxerVoiceTransport;
  private socket?: WebSocket; private handler?: MessageHandler; private stopped = true;
  private heartbeat?: NodeJS.Timeout; private reconnect?: NodeJS.Timeout; private attempts = 0;
  private sequence: number | null = null; private sessionId?: string; private selfId?: string;
  private memberVoice = new Map<string, Map<string, string>>();
  private voiceWaiters = new Map<string, { resolve: (value: VoiceCredentials & { connectionId: string }) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; channelId: string }>();
  constructor(private token: string, private fetcher: Fetch = fetch, private sockets: SocketFactory = defaultSocketFactory) { this.voice = new FluxerVoiceTransport(this); }

  async start(onMessage: MessageHandler): Promise<void> { this.handler = onMessage; this.stopped = false; this.connect(); }
  private connect() {
    if (this.stopped) return;
    console.log("[Fluxer] Connecting...");
    const socket = this.sockets(GATEWAY); this.socket = socket;
    socket.on("message", data => this.receive(data));
    socket.on("error", error => console.error(`[Fluxer] WebSocket error: ${error.message}`));
    socket.on("close", (code, reason) => { this.clearHeartbeat(); if (this.socket === socket) this.socket = undefined; if (!this.stopped) { console.warn(`[Fluxer] Disconnected (${code}${reason.length ? `: ${reason.toString()}` : ""}); reconnecting`); this.scheduleReconnect(); } });
  }
  private receive(raw: RawData) {
    try { this.handleGatewayEvent(JSON.parse(raw.toString()) as unknown); }
    catch (error) { console.error(`[Fluxer] Invalid gateway packet: ${error instanceof Error ? error.message : String(error)}`); }
  }
  /** Exposed to permit protocol normalization tests without a live gateway. */
  handleGatewayEvent(value: unknown) {
    const packet = record(value); if (!packet || typeof packet.op !== "number") return;
    if (typeof packet.s === "number") this.sequence = packet.s;
    if (packet.op === 10) { const d = record(packet.d); const interval = d?.heartbeat_interval; if (typeof interval !== "number") throw new Error("HELLO missing heartbeat_interval"); this.startHeartbeat(interval); this.send(this.sessionId ? { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } } : { op: 2, d: { token: this.token, properties: { os: process.platform, browser: "aria", device: "aria" }, presence: { status: "online", afk: false, mobile: false }, flags: 0 } }); return; }
    if (packet.op === 1) { this.send({ op: 1, d: this.sequence }); return; }
    if (packet.op === 7) { this.socket?.close(4000, "Gateway requested reconnect"); return; }
    if (packet.op === 9) { if (packet.d !== true) this.sessionId = undefined; this.socket?.close(4000, "Invalid session"); return; }
    if (packet.op === 12) { const d = record(packet.d), code = text(d?.code); console.error(`[Fluxer] Gateway error${code ? ` ${code}` : ""}: ${String(d?.message ?? "unknown")}`); if (code?.startsWith("VOICE_")) { const message = code === "VOICE_PERMISSION_DENIED" ? "Missing permission to connect or speak in that Fluxer voice channel." : `Fluxer voice request failed (${code}).`; for (const [guildId, waiter] of this.voiceWaiters) { clearTimeout(waiter.timeout); waiter.reject(new Error(message)); this.voiceWaiters.delete(guildId); } } return; }
    if (packet.op !== 0 || typeof packet.t !== "string") return;
    const d = record(packet.d); if (!d) return;
    if (packet.t === "READY") { this.memberVoice.clear(); this.sessionId = text(d.session_id); const user = record(d.user); this.selfId = text(user?.id); this.attempts = 0; console.log(`[Fluxer] Authenticated as ${text(user?.username) ?? "bot"} (${this.selfId ?? "unknown id"})`); console.log("[Fluxer] Ready"); return; }
    if (packet.t === "RESUMED") { this.attempts = 0; console.log("[Fluxer] Ready (session resumed)"); return; }
    if (packet.t === "GUILD_CREATE") { this.replaceGuildVoice(d); return; }
    if (packet.t === "GUILD_DELETE") { const guildId = text(d.id); if (guildId) this.memberVoice.delete(guildId); return; }
    if (packet.t === "VOICE_STATE_UPDATE") { const guildId = text(d.guild_id), uid = text(d.user_id), cid = text(d.channel_id); if (guildId && uid) this.updateMemberVoice(guildId, uid, cid); return; }
    if (packet.t === "VOICE_SERVER_UPDATE") { const guildId = text(d.guild_id), channelId = text(d.channel_id), token = text(d.token), endpoint = text(d.endpoint), connectionId = text(d.connection_id); const waiter = guildId ? this.voiceWaiters.get(guildId) : undefined; if (waiter && channelId === waiter.channelId && token && endpoint && connectionId) { clearTimeout(waiter.timeout); this.voiceWaiters.delete(guildId!); waiter.resolve({ token, endpoint, connectionId }); } return; }
    if (packet.t === "MESSAGE_CREATE") void this.normalizeMessage(d);
  }
  private async normalizeMessage(message: Record<string, unknown>) {
    const content = text(message.content), channelId = text(message.channel_id), guildId = text(message.guild_id), author = record(message.author), userId = text(author?.id);
    if (!content || !channelId || !guildId || !userId || userId === this.selfId || author?.bot === true || !this.handler) return;
    await this.handler({ guildId, channelId, userId, voiceChannelId: this.memberVoice.get(guildId)?.get(userId), reply: async (reply, components) => { await this.sendMessage(channelId, reply, components); } }, content);
  }
  private replaceGuildVoice(guild: Record<string, unknown>) {
    const guildId = text(guild.id); if (!guildId) return;
    const voice = new Map<string, string>();
    if (Array.isArray(guild.voice_states)) for (const value of guild.voice_states) {
      const state = record(value), userId = text(state?.user_id), channelId = text(state?.channel_id);
      if (userId && channelId) voice.set(userId, channelId);
    }
    this.memberVoice.set(guildId, voice);
  }
  private updateMemberVoice(guildId: string, userId: string, channelId?: string) {
    const voice = this.memberVoice.get(guildId);
    if (channelId) {
      const current = voice ?? new Map<string, string>(); current.set(userId, channelId);
      if (!voice) this.memberVoice.set(guildId, current);
    } else {
      voice?.delete(userId);
      if (voice?.size === 0) this.memberVoice.delete(guildId);
    }
  }
  private async sendMessage(channel: string, content: string, components?: unknown) {
    const body: Record<string, unknown> = { content }; if (components !== undefined) body.components = components;
    await checkedJson(await this.fetcher(`${API}/channels/${encodeURIComponent(channel)}/messages`, { method: "POST", headers: { Authorization: `Bot ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), "Fluxer");
  }
  private send(packet: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(packet)); }
  requestVoice(guildId: string, channelId: string | null, connectionId?: string) { this.send({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false, self_video: false, self_stream: false, viewer_stream_keys: [], connection_id: connectionId ?? null } }); }
  waitForVoiceServer(guildId: string, channelId: string) { return new Promise<VoiceCredentials & { connectionId: string }>((resolve, reject) => { const prior = this.voiceWaiters.get(guildId); if (prior) { clearTimeout(prior.timeout); prior.reject(new Error("Fluxer voice connection was superseded.")); } const timeout = setTimeout(() => { this.voiceWaiters.delete(guildId); reject(new Error("Fluxer voice server assignment timed out.")); }, 15_000); this.voiceWaiters.set(guildId, { resolve, reject, timeout, channelId }); }); }
  private startHeartbeat(ms: number) { this.clearHeartbeat(); this.heartbeat = setInterval(() => this.send({ op: 1, d: this.sequence }), ms); }
  private clearHeartbeat() { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined; }
  private scheduleReconnect() { if (this.stopped || this.reconnect) return; const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5)); this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect(); }, delay); }
  async stop() { await this.voice.shutdown(); this.stopped = true; this.clearHeartbeat(); if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined; for (const waiter of this.voiceWaiters.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("Fluxer stopped.")); } this.voiceWaiters.clear(); const socket = this.socket; this.socket = undefined; socket?.close(1000, "Aria shutting down"); console.log("[Fluxer] Stopped"); }
}
