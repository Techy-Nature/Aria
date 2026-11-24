import WebSocket, { type RawData } from "ws";
import type { PlatformAdapter } from "../types.js";
import { checkedJson, defaultSocketFactory, record, text, type Fetch, type MessageHandler, type SocketFactory } from "./common.js";
import { StoatVoiceTransport } from "../voice/stoat.js";

const API = "https://api.stoat.chat"; const EVENTS = "wss://events.stoat.chat/?version=1&format=json";
/** How long a one-off voice check may wait for Stoat's Ready before giving up. */
const VOICE_CHECK_TIMEOUT_MS = 8_000;

export interface StoatAdapterOptions {
  /** How long a one-off voice check may wait for Ready (tests pass a short one). */
  voiceCheckTimeoutMs?: number;
}

/** Reads Stoat channel voice states ({ id: channel, participants: [{ id: user }] }) as [user, channel] pairs. */
export function parseVoiceStates(states: unknown[]): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const item of states) {
    const state = record(item), channelId = text(state?.id);
    if (!channelId || !Array.isArray(state?.participants)) continue;
    for (const p of state.participants) { const userId = text(record(p)?.id); if (userId) found.push([userId, channelId]); }
  }
  return found;
}

/**
 * Who is in which voice channel, as Stoat reports it. Stoat sends the full list in Ready
 * (and ServerCreate), then VoiceChannelJoin / VoiceChannelLeave / VoiceChannelMove as people
 * come and go. Those shapes match the official stoat.js client (src/events/v1.ts).
 */
class VoiceRoster {
  private readonly users = new Map<string, string>(); // user id -> voice channel id
  get(userId: string) { return this.users.get(userId); }
  get size() { return this.users.size; }
  /** Replaces everything with a fresh list, so people who left while Aria was offline drop out. */
  replace(states: unknown[]) { this.users.clear(); this.add(states); }
  add(states: unknown[]) { for (const [userId, channelId] of parseVoiceStates(states)) this.users.set(userId, channelId); }
  join(userId: string, channelId: string) { this.users.set(userId, channelId); }
  /** Only forgets the user if they were in that channel, so a late leave can't undo a newer join elsewhere. */
  leave(userId: string, channelId?: string) { if (!channelId || this.users.get(userId) === channelId) this.users.delete(userId); }
}

export class StoatAdapter implements PlatformAdapter {
  readonly voice: StoatVoiceTransport;
  private socket?: WebSocket; private handler?: MessageHandler; private stopped = true; private ping?: NodeJS.Timeout; private reconnect?: NodeJS.Timeout; private attempts = 0; private selfId?: string;
  private channels = new Map<string, string>(); private roster = new VoiceRoster();
  private readonly voiceCheckTimeoutMs: number;
  constructor(private token: string, private fetcher: Fetch = fetch, private sockets: SocketFactory = defaultSocketFactory, options: StoatAdapterOptions = {}) {
    this.voice = new StoatVoiceTransport(token, fetcher as typeof fetch);
    this.voiceCheckTimeoutMs = options.voiceCheckTimeoutMs ?? VOICE_CHECK_TIMEOUT_MS;
  }
  async start(onMessage: MessageHandler) { this.handler = onMessage; this.stopped = false; this.connect(); }
  private connect() {
    if (this.stopped) return; console.log("[Stoat] Connecting..."); const socket = this.sockets(EVENTS); this.socket = socket;
    socket.on("open", () => { if (this.socket !== socket) return; this.send({ type: "Authenticate", token: this.token }); this.clearPing(); this.ping = setInterval(() => this.send({ type: "Ping", data: Date.now() }), 30_000); });
    // Only the current connection counts; ignore anything a replaced one still delivers.
    socket.on("message", data => { if (this.socket === socket) this.receive(data); });
    socket.on("error", e => console.error(`[Stoat] WebSocket error: ${e.message}`));
    socket.on("close", (code, reason) => { if (this.socket !== socket) return; this.clearPing(); this.socket = undefined; if (!this.stopped) { console.warn(`[Stoat] Disconnected (${code}${reason.length ? `: ${reason.toString()}` : ""}); reconnecting`); this.scheduleReconnect(); } });
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
    if (event.type === "Ready") {
      this.loadReady(event); this.attempts = 0;
      console.log(`[Stoat] Authenticated as bot (${this.selfId ?? "unknown id"})`);
      console.log(`[Stoat] Ready (${Array.isArray(event.voice_states) ? `${this.roster.size} in voice` : "no voice list from Stoat"})`);
      return;
    }
    if (event.type === "ServerCreate") { this.loadChannels(event.channels); if (Array.isArray(event.voice_states)) this.roster.add(event.voice_states); return; }
    if (event.type === "ChannelCreate") { this.loadChannels([event]); return; }
    if (event.type === "VoiceChannelJoin") { const uid = text(record(event.state)?.id), cid = text(event.id); if (uid && cid) { this.roster.join(uid, cid); console.log(`[Stoat] Voice: ${uid} joined ${cid}`); } return; }
    if (event.type === "VoiceChannelLeave") { const uid = text(event.user), cid = text(event.id); if (uid) { this.roster.leave(uid, cid); console.log(`[Stoat] Voice: ${uid} left ${cid ?? "voice"}`); } return; }
    if (event.type === "VoiceChannelMove") { const uid = text(event.user), cid = text(event.to); if (uid && cid) { this.roster.join(uid, cid); console.log(`[Stoat] Voice: ${uid} moved to ${cid}`); } return; }
    if (event.type === "Message") void this.normalizeMessage(event);
  }
  private loadReady(event: Record<string, unknown>) {
    this.loadChannels(event.channels);
    // Stoat's RelationshipStatus "User" means the current session user. This is
    // also the exact mechanism used by the official JS client's Ready handler:
    // stoatchat/javascript-client-sdk, src/events/v1.ts (handleEvent/Ready).
    if (Array.isArray(event.users)) for (const item of event.users) { const u = record(item); if (u?.relationship === "User") this.selfId = text(u._id); }
    // Ready is a full snapshot. Without clearing, anyone who left while Aria was reconnecting stays "in voice".
    if (Array.isArray(event.voice_states)) this.roster.replace(event.voice_states);
  }
  private loadChannels(channels: unknown) {
    if (Array.isArray(channels)) for (const item of channels) { const c = record(item), id = text(c?._id), server = text(c?.server); if (id && server) this.channels.set(id, server); }
  }
  private async normalizeMessage(message: Record<string, unknown>) {
    const content = text(message.content), channelId = text(message.channel), userId = text(message.author), guildId = channelId ? this.channels.get(channelId) : undefined;
    if (!content || !channelId || !guildId || !userId || userId === this.selfId || message.webhook !== undefined || !this.handler) return;
    await this.handler({
      guildId, channelId, userId, voiceChannelId: this.roster.get(userId),
      findVoiceChannel: () => this.checkVoiceChannel(userId),
      reply: async reply => { await this.sendMessage(channelId, reply); },
    }, content);
  }
  /**
   * Asks Stoat directly where a user is when Aria's own list says "nowhere". Live voice events can be
   * missed (Aria's Stoat connection drops and reconnects many times a day), so this opens a short second
   * connection, reads the voice list from its Ready, and closes it. The main connection is left alone.
   */
  async checkVoiceChannel(userId: string): Promise<string | undefined> {
    const known = this.roster.get(userId); if (known) return known;
    const states = await this.fetchVoiceStates();
    if (!states) { console.warn(`[Stoat] Voice check for ${userId}: Stoat did not answer`); return undefined; }
    const found = parseVoiceStates(states);
    const channelId = found.find(([uid]) => uid === userId)?.[1];
    console.log(`[Stoat] Voice check for ${userId}: ${channelId ? `in ${channelId} (Aria had missed the join)` : "not in voice"}; Stoat lists ${found.length} in voice`);
    if (channelId) this.roster.join(userId, channelId);
    return channelId;
  }
  private fetchVoiceStates(): Promise<unknown[] | undefined> {
    return new Promise(resolve => {
      let socket: WebSocket;
      try { socket = this.sockets(EVENTS); } catch (e) { console.error(`[Stoat] Voice check could not connect: ${e instanceof Error ? e.message : String(e)}`); resolve(undefined); return; }
      let done = false;
      const finish = (states: unknown[] | undefined) => { if (done) return; done = true; clearTimeout(timer); try { socket.close(1000, "Voice check done"); } catch { /* already closed */ } resolve(states); };
      const timer = setTimeout(() => finish(undefined), this.voiceCheckTimeoutMs);
      socket.on("open", () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "Authenticate", token: this.token })); });
      socket.on("message", data => {
        let event: Record<string, unknown> | undefined;
        try { event = record(JSON.parse(data.toString()) as unknown); } catch { return; }
        const ready = event?.type === "Bulk" && Array.isArray(event.v) ? event.v.map(record).find(e => e?.type === "Ready") : event?.type === "Ready" ? event : undefined;
        if (ready) finish(Array.isArray(ready.voice_states) ? ready.voice_states : []);
        else if (event?.type === "Error") finish(undefined);
      });
      socket.on("error", () => finish(undefined));
      socket.on("close", () => finish(undefined));
    });
  }
  private async sendMessage(channel: string, content: string) { await checkedJson(await this.fetcher(`${API}/channels/${encodeURIComponent(channel)}/messages`, { method: "POST", headers: { "X-Bot-Token": this.token, "Content-Type": "application/json" }, body: JSON.stringify({ content }) }), "Stoat"); }
  private send(event: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
  private clearPing() { if (this.ping) clearInterval(this.ping); this.ping = undefined; }
  private scheduleReconnect() { if (this.stopped || this.reconnect) return; const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5)); this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect(); }, delay); }
  async stop() { await this.voice.shutdown(); this.stopped = true; this.clearPing(); if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined; const socket = this.socket; this.socket = undefined; socket?.close(1000, "Aria shutting down"); console.log("[Stoat] Stopped"); }
}
