import type { CommandContext, PlatformAdapter } from "../types.js";
import type { AudioSource, PlaybackEvent, VoiceTransport } from "../voice/types.js";

export interface NamedAdapter { name: string; adapter: PlatformAdapter }

const SEPARATOR = ":";
const scoped = (name: string, guildId: string) => `${name}${SEPARATOR}${guildId}`;

/**
 * Routes one shared VoiceTransport interface to each platform's own transport.
 * Guild ids arrive scoped as "<platform>:<guildId>" so queues, settings and
 * playback generations never collide between Fluxer and Stoat servers.
 */
export class MultiVoiceTransport implements VoiceTransport {
  private readonly transports = new Map<string, VoiceTransport>();
  constructor(entries: Array<{ name: string; transport: VoiceTransport }>) { for (const { name, transport } of entries) this.transports.set(name, transport); }
  private route(guildId: string): { transport: VoiceTransport; local: string } {
    const index = guildId.indexOf(SEPARATOR); const name = index > 0 ? guildId.slice(0, index) : "";
    const transport = this.transports.get(name);
    if (!transport) throw new Error(`No voice transport for guild "${guildId}"`);
    return { transport, local: guildId.slice(index + 1) };
  }
  connect(guildId: string, channelId: string) { const r = this.route(guildId); return r.transport.connect(r.local, channelId); }
  disconnect(guildId: string) { const r = this.route(guildId); return r.transport.disconnect(r.local); }
  play(guildId: string, source: AudioSource, generation: number) { const r = this.route(guildId); return r.transport.play(r.local, source, generation); }
  pause(guildId: string) { const r = this.route(guildId); return r.transport.pause(r.local); }
  resume(guildId: string) { const r = this.route(guildId); return r.transport.resume(r.local); }
  stop(guildId: string) { const r = this.route(guildId); return r.transport.stop(r.local); }
  seek(guildId: string, positionSeconds: number, generation: number) { const r = this.route(guildId); return r.transport.seek(r.local, positionSeconds, generation); }
  isConnected(guildId: string) { const r = this.route(guildId); return r.transport.isConnected(r.local); }
  channelId(guildId: string) { const r = this.route(guildId); return r.transport.channelId(r.local); }
  onPlayback(listener: (event: PlaybackEvent) => void) {
    const unsubscribers = [...this.transports].map(([name, transport]) => transport.onPlayback(event => listener({ ...event, guildId: scoped(name, event.guildId) })));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }
  async shutdown() { await Promise.allSettled([...this.transports.values()].map(transport => transport.shutdown())); }
}

/** Runs several chat platforms in one process, e.g. ARIA_PLATFORM=both. */
export class MultiPlatformAdapter implements PlatformAdapter {
  readonly voice?: VoiceTransport;
  constructor(private readonly adapters: NamedAdapter[]) {
    const names = new Set<string>();
    for (const { name } of adapters) { if (!name || name.includes(SEPARATOR) || names.has(name)) throw new Error(`Invalid or duplicate platform name "${name}"`); names.add(name); }
    const voiced = adapters.flatMap(({ name, adapter }) => adapter.voice ? [{ name, transport: adapter.voice }] : []);
    this.voice = voiced.length ? new MultiVoiceTransport(voiced) : undefined;
  }
  async start(onMessage: (ctx: CommandContext, content: string) => Promise<void>) {
    await Promise.all(this.adapters.map(({ name, adapter }) => adapter.start((ctx, content) => onMessage({ ...ctx, guildId: scoped(name, ctx.guildId), reply: ctx.reply }, content))));
    console.log(`Aria connected to: ${this.adapters.map(({ name }) => name).join(", ")}`);
  }
  async stop() { await Promise.allSettled(this.adapters.map(({ adapter }) => adapter.stop())); }
}
