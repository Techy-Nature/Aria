import WebSocket, { type RawData } from "ws";
import type { PlatformAdapter } from "../types.js";
import { checkedJson, defaultSocketFactory, record, text, type Fetch, type MessageHandler, type SocketFactory } from "./common.js";
import { FluxerVoiceTransport, type FluxerVoiceGateway } from "../voice/fluxer.js";
import type { VoiceCredentials } from "../voice/livekit.js";

const API = "https://api.fluxer.app/v1";
const GATEWAY = "wss://gateway.fluxer.app/?v=1&encoding=json";

/** Give up on a connection attempt that has not reached HELLO in this time, and try again. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Longest wait between reconnect attempts. */
const MAX_BACKOFF_MS = 30_000;
/** Fluxer asks clients to wait at least a minute after close code 4008 (rate limited). */
const RATE_LIMIT_WAIT_MS = 60_000;
/** Close codes after which reconnecting cannot help (Fluxer gateway docs, "close codes"). */
const FATAL_CLOSE_CODES = new Map<number, string>([
  [4004, "the bot token was rejected; check ARIA_TOKEN"],
  [4010, "invalid shard"],
  [4011, "sharding required"],
  [4012, "invalid gateway version"],
  [4013, "invalid intents"],
  [4014, "disallowed intents"],
]);
/** Close codes that end the session: the next connection has to IDENTIFY instead of RESUME. */
const NEW_SESSION_CLOSE_CODES = new Set([4007, 4009]);
const RATE_LIMITED = 4008;
/** Close code Aria uses itself when it drops a connection but wants to keep the session resumable. */
const RESUMABLE_CLOSE = 4000;

export interface FluxerAdapterOptions {
  /** How long a connection attempt may take to reach HELLO before it is abandoned. */
  connectTimeoutMs?: number;
  /** Source of randomness for heartbeat and backoff jitter (tests pass a fixed one). */
  random?: () => number;
}

/** Fluxer gateway adapter based on the current fluxerapp/fluxer gateway opcodes. */
export class FluxerAdapter implements PlatformAdapter, FluxerVoiceGateway {
  readonly voice: FluxerVoiceTransport;
  private socket?: WebSocket; private handler?: MessageHandler; private stopped = true;
  private heartbeatStart?: NodeJS.Timeout; private heartbeat?: NodeJS.Timeout; private awaitingAck = false;
  private connectTimer?: NodeJS.Timeout; private helloReceived = false; private usingResumeUrl = false;
  private reconnect?: NodeJS.Timeout; private attempts = 0; private nextDelay?: number;
  private sequence: number | null = null; private sessionId?: string; private resumeUrl?: string; private selfId?: string;
  private offlineSince?: number;
  private memberVoice = new Map<string, Map<string, string>>();
  private voiceWaiters = new Map<string, { resolve: (value: VoiceCredentials & { connectionId: string }) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; channelId: string }>();
  private readonly connectTimeoutMs: number;
  private readonly random: () => number;

  constructor(private token: string, private fetcher: Fetch = fetch, private sockets: SocketFactory = defaultSocketFactory, options: FluxerAdapterOptions = {}) {
    this.voice = new FluxerVoiceTransport(this);
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.random = options.random ?? Math.random;
  }

  async start(onMessage: MessageHandler): Promise<void> { this.handler = onMessage; this.stopped = false; this.connect(); }

  private connect() {
    if (this.stopped) return;
    const resuming = Boolean(this.sessionId);
    this.usingResumeUrl = resuming && Boolean(this.resumeUrl);
    const url = this.usingResumeUrl ? this.resumeUrl! : GATEWAY;
    console.log(resuming ? "[Fluxer] Connecting to resume the session..." : "[Fluxer] Connecting...");
    this.helloReceived = false;
    const socket = this.sockets(url); this.socket = socket;
    // A connection that hangs before HELLO (for example a gateway that never answers the
    // upgrade) would otherwise wait forever while the session expires. Abandon it and retry.
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      if (this.socket !== socket || this.helloReceived) return;
      console.warn(`[Fluxer] Gateway did not answer within ${Math.round(this.connectTimeoutMs / 1000)}s; retrying`);
      this.abort(socket);
    }, this.connectTimeoutMs);
    socket.on("message", data => { if (this.socket === socket) this.receive(data); });
    socket.on("error", error => console.error(`[Fluxer] WebSocket error: ${error.message}`));
    socket.on("close", (code, reason) => this.handleClose(socket, code, reason));
  }

  private handleClose(socket: WebSocket, code: number, reason: Buffer) {
    if (this.socket !== socket) return; // An older connection closing late; the current one handles itself.
    this.socket = undefined;
    this.clearHeartbeat(); this.clearConnectTimer();
    if (this.stopped) return;
    this.offlineSince ??= Date.now();
    // If the session's own resume address never got us to HELLO, use the main gateway next time.
    if (this.usingResumeUrl && !this.helloReceived) this.resumeUrl = undefined;
    const detail = `${code}${reason.length ? `: ${reason.toString()}` : ""}`;

    const fatal = FATAL_CLOSE_CODES.get(code);
    if (fatal) { console.error(`[Fluxer] Disconnected (${detail}); not reconnecting because ${fatal}`); return; }
    if (NEW_SESSION_CLOSE_CODES.has(code)) this.resetSession();
    let delay = this.nextDelay; this.nextDelay = undefined;
    if (code === RATE_LIMITED) delay = RATE_LIMIT_WAIT_MS;
    console.warn(`[Fluxer] Disconnected (${detail}); ${this.sessionId ? "reconnecting to resume the session" : "reconnecting with a new session"}`);
    this.scheduleReconnect(delay);
  }

  private receive(raw: RawData) {
    try { this.handleGatewayEvent(JSON.parse(raw.toString()) as unknown); }
    catch (error) { console.error(`[Fluxer] Invalid gateway packet: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Exposed to permit protocol normalization tests without a live gateway. */
  handleGatewayEvent(value: unknown) {
    const packet = record(value); if (!packet || typeof packet.op !== "number") return;
    // Only dispatches carry the sequence number that RESUME and heartbeats report back.
    if (packet.op === 0 && typeof packet.s === "number") this.sequence = packet.s;
    if (packet.op === 10) {
      const d = record(packet.d); const interval = d?.heartbeat_interval;
      if (typeof interval !== "number") throw new Error("HELLO missing heartbeat_interval");
      this.helloReceived = true; this.clearConnectTimer();
      this.startHeartbeat(interval);
      this.send(this.sessionId
        ? { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } }
        : { op: 2, d: { token: this.token, properties: { os: process.platform, browser: "aria", device: "aria" }, presence: { status: "online", afk: false, mobile: false }, flags: 0 } });
      return;
    }
    if (packet.op === 11) { this.awaitingAck = false; return; }
    if (packet.op === 1) { this.send({ op: 1, d: this.sequence }); return; }
    if (packet.op === 7) {
      console.log("[Fluxer] Gateway asked Aria to reconnect");
      this.nextDelay = 0;
      this.socket?.close(RESUMABLE_CLOSE, "Gateway requested reconnect");
      return;
    }
    if (packet.op === 9) {
      const resumable = packet.d === true;
      if (!resumable) this.resetSession();
      console.warn(`[Fluxer] Gateway invalidated the session (${resumable ? "resumable" : "starting a new one"})`);
      // Fluxer's docs say to send a new IDENTIFY; a short random pause avoids hammering it.
      this.nextDelay = 1_000 + Math.floor(this.random() * 2_000);
      this.socket?.close(RESUMABLE_CLOSE, "Invalid session");
      return;
    }
    if (packet.op === 12) { const d = record(packet.d), code = text(d?.code); console.error(`[Fluxer] Gateway error${code ? ` ${code}` : ""}: ${String(d?.message ?? "unknown")}`); if (code?.startsWith("VOICE_")) { const message = code === "VOICE_PERMISSION_DENIED" ? "Missing permission to connect or speak in that Fluxer voice channel." : `Fluxer voice request failed (${code}).`; for (const [guildId, waiter] of this.voiceWaiters) { clearTimeout(waiter.timeout); waiter.reject(new Error(message)); this.voiceWaiters.delete(guildId); } } return; }
    if (packet.op !== 0 || typeof packet.t !== "string") return;
    const d = record(packet.d); if (!d) return;
    if (packet.t === "READY") {
      this.memberVoice.clear();
      this.sessionId = text(d.session_id); this.resumeUrl = resumeGatewayUrl(d.resume_gateway_url);
      const user = record(d.user); this.selfId = text(user?.id);
      console.log(`[Fluxer] Authenticated as ${text(user?.username) ?? "bot"} (${this.selfId ?? "unknown id"})`);
      console.log(`[Fluxer] Ready${this.backOnline(" (new session after ", " offline)")}`);
      return;
    }
    if (packet.t === "RESUMED") { console.log(`[Fluxer] Ready (session resumed${this.backOnline(" after ", " offline")})`); return; }
    if (packet.t === "GUILD_CREATE") { this.replaceGuildVoice(d); return; }
    if (packet.t === "GUILD_DELETE") { const guildId = text(d.id); if (guildId) this.memberVoice.delete(guildId); return; }
    if (packet.t === "VOICE_STATE_UPDATE") { const guildId = text(d.guild_id), uid = text(d.user_id), cid = text(d.channel_id); if (guildId && uid) this.updateMemberVoice(guildId, uid, cid); return; }
    if (packet.t === "VOICE_SERVER_UPDATE") { const guildId = text(d.guild_id), channelId = text(d.channel_id), token = text(d.token), endpoint = text(d.endpoint), connectionId = text(d.connection_id); const waiter = guildId ? this.voiceWaiters.get(guildId) : undefined; if (waiter && channelId === waiter.channelId && token && endpoint && connectionId) { clearTimeout(waiter.timeout); this.voiceWaiters.delete(guildId!); waiter.resolve({ token, endpoint, connectionId }); } return; }
    if (packet.t === "MESSAGE_CREATE") void this.normalizeMessage(d);
  }

  /** Resets the reconnect backoff and describes how long Aria was offline, if it was. */
  private backOnline(prefix: string, suffix: string) {
    this.attempts = 0;
    const since = this.offlineSince; this.offlineSince = undefined;
    if (since === undefined) return "";
    return `${prefix}${((Date.now() - since) / 1000).toFixed(1)}s${suffix}`;
  }

  /** Forgets the session so the next connection sends IDENTIFY instead of RESUME. */
  private resetSession() { this.sessionId = undefined; this.sequence = null; this.resumeUrl = undefined; }

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
  requestVoice(guildId: string, channelId: string | null, connectionId?: string) { const d: Record<string, unknown> = { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false, self_video: false, self_stream: false, viewer_stream_keys: [] }; if (connectionId !== undefined) d.connection_id = connectionId; this.send({ op: 4, d }); }
  waitForVoiceServer(guildId: string, channelId: string) { return new Promise<VoiceCredentials & { connectionId: string }>((resolve, reject) => { const prior = this.voiceWaiters.get(guildId); if (prior) { clearTimeout(prior.timeout); prior.reject(new Error("Fluxer voice connection was superseded.")); } const timeout = setTimeout(() => { this.voiceWaiters.delete(guildId); reject(new Error("Fluxer voice server assignment timed out.")); }, 15_000); this.voiceWaiters.set(guildId, { resolve, reject, timeout, channelId }); }); }

  /**
   * Sends heartbeats every `ms`, starting after a random part of the first interval. If the
   * gateway has not acknowledged the previous heartbeat by the time the next one is due, the
   * connection is a zombie: drop it at once and reconnect, keeping the session so it resumes.
   */
  private startHeartbeat(ms: number) {
    this.clearHeartbeat();
    const socket = this.socket;
    const beat = () => {
      if (this.socket !== socket) { this.clearHeartbeat(); return; }
      if (this.awaitingAck) {
        console.warn("[Fluxer] Gateway stopped acknowledging heartbeats; reconnecting to resume");
        this.clearHeartbeat();
        if (socket) this.abort(socket);
        return;
      }
      this.awaitingAck = true;
      this.send({ op: 1, d: this.sequence });
    };
    this.heartbeatStart = setTimeout(() => {
      this.heartbeatStart = undefined;
      beat();
      if (this.socket === socket && this.socket) this.heartbeat = setInterval(beat, ms);
    }, Math.floor(ms * this.random()));
  }
  private clearHeartbeat() {
    if (this.heartbeatStart) clearTimeout(this.heartbeatStart); this.heartbeatStart = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined;
    this.awaitingAck = false;
  }
  private clearConnectTimer() { if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = undefined; }

  /** Drops a connection immediately. A normal close waits for the other side, which a dead connection never sends. */
  private abort(socket: WebSocket) {
    if (typeof socket.terminate === "function") socket.terminate();
    else socket.close(RESUMABLE_CLOSE, "Connection lost");
  }

  /**
   * The first retry after a drop goes out at once, as fluxer.py does, so a session can resume
   * before the gateway forgets it. Later retries back off 1-2s, 2-4s, 4-8s ... up to 30s.
   */
  private scheduleReconnect(delay?: number) {
    if (this.stopped || this.reconnect) return;
    const attempt = this.attempts++;
    const wait = delay ?? (attempt === 0 ? 0 : Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt - 1, 5) * (1 + this.random())));
    if (wait >= 1_000) console.log(`[Fluxer] Next connection attempt in ${(wait / 1000).toFixed(1)}s`);
    this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect(); }, wait);
  }

  async stop() {
    // Stop reconnecting before anything else awaits, so a pending retry cannot open a new socket.
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined;
    this.clearConnectTimer();
    await this.voice.shutdown();
    this.clearHeartbeat();
    for (const waiter of this.voiceWaiters.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("Fluxer stopped.")); }
    this.voiceWaiters.clear();
    const socket = this.socket; this.socket = undefined; socket?.close(1000, "Aria shutting down"); console.log("[Fluxer] Stopped");
  }
}

/** The address READY gives for resuming this session, with the query Aria's gateway URL uses. */
function resumeGatewayUrl(value: unknown): string | undefined {
  const raw = text(value); if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "wss:") return undefined;
    url.searchParams.set("v", "1"); url.searchParams.set("encoding", "json");
    return url.toString();
  } catch { return undefined; }
}
