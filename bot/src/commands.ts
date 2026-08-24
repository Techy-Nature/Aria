import type { CommandContext, LoopMode, Track } from "./types.js";
import { PlayerManager } from "./player.js";
import { SearchService } from "./search.js";
import { SettingsStore } from "./store.js";
import { PlaybackFeedback } from "./voice/feedback.js";
import type { PlayableSourceResolver } from "./voice/source.js";

const aliases: Record<string, string> = { h: "help", pre: "prefix", sch: "search", dr: "defresult", pk: "pick", p: "play", enq: "enqueue", l: "loop", tl: "toggleloop", ql: "queuelist", dq: "defqueue", sk: "skip", rew: "rewind", rel: "reload", re: "restart", prv: "previous", ps: "pause", s: "stop", str: "stop-remove" };

const helpCommands = [
  ["help", "h", "Show this command guide."],
  ["prefix <prefix>", "pre", "Change the server prefix (1–8 characters)."],
  ["search [count] <terms>", "sch", "Show and save numbered search results."],
  ["defresult <count>", "dr", "Set default search results (1–25)."],
  ["pick <number>", "pk", "Queue a result from your latest search."],
  ["play <terms-or-url>", "p", "Add a song or playlist to the queue."],
  ["enqueue <terms-or-url>", "enq", "Insert a song immediately after the current one."],
  ["loop", "l", "Show the song, playlist, and off loop choices."],
  ["toggleloop <song|playlist|off>", "tl <s|pl|off>", "Toggle a loop mode."],
  ["queuelist", "ql", "Show the current queue."],
  ["defqueue <count>", "dq", "Set displayed queue entries (1–25)."],
  ["skip", "sk", "Advance to the next track."],
  ["rewind", "rew", "Return to the current track's beginning."],
  ["reload", "rel", "Return to the current playlist's beginning."],
  ["restart", "re", "Return to the complete queue's beginning."],
  ["previous", "prv", "Play the previous track."],
  ["pause", "ps", "Toggle pause or resume."],
  ["stop", "s", "Stop and leave voice, retaining the queue."],
  ["stop-remove", "str", "Stop, clear the queue, and leave voice."],
] as const;

function helpMessage(prefix: string, defaultResults: number, queuePageSize: number) {
  const commands = helpCommands.map(([usage, alias, description]) => `\`${prefix}${usage}\` (\`${alias}\`) — ${description}`).join("\n");
  return `**Aria commands**\n${commands}\n\n\`<value>\` is required; \`[value]\` is optional. Current defaults: prefix \`${prefix}\`, ${defaultResults} search results, ${queuePageSize} queue entries.`;
}
export class CommandRouter {
  private readonly searches = new Map<string, Track[]>();
  constructor(readonly settings: SettingsStore, readonly players: PlayerManager, readonly search: SearchService, private readonly sources: PlayableSourceResolver = search.sources, private readonly feedback?: PlaybackFeedback) {}
  async handle(ctx: CommandContext, content: string) {
    const cfg = this.settings.get(ctx.guildId); if (!content.startsWith(cfg.prefix)) return;
    const parts = content.slice(cfg.prefix.length).trim().split(/\s+/); const command = aliases[parts.shift()?.toLowerCase() ?? ""] ?? content.slice(cfg.prefix.length).trim().split(/\s+/)[0]?.toLowerCase();
    const args = parts; const number = (value: string | undefined, fallback: number) => Math.max(1, Math.min(25, Number(value) || fallback));
    try {
      switch (command) {
        case "help": return ctx.reply(helpMessage(cfg.prefix, cfg.defaultResults, cfg.queuePageSize));
        case "prefix": { const value = args[0]; if (!value || value.length > 8) return ctx.reply("Prefix must be 1–8 characters."); this.settings.update(ctx.guildId, { prefix: value }); return ctx.reply(`Prefix changed to **${value}**.`); }
        case "defresult": this.settings.update(ctx.guildId, { defaultResults: number(args[0], 10) }); return ctx.reply(`Default search results: **${this.settings.get(ctx.guildId).defaultResults}**.`);
        case "defqueue": this.settings.update(ctx.guildId, { queuePageSize: number(args[0], 10) }); return ctx.reply(`Queue page size: **${this.settings.get(ctx.guildId).queuePageSize}**.`);
        case "search": { const explicit = /^\d+$/.test(args[0] ?? "") ? Number(args.shift()) : cfg.defaultResults; const query = args.join(" "); if (!query) return ctx.reply("Give me something to search for."); const results = await this.search.search(query, number(String(explicit), cfg.defaultResults)); this.searches.set(`${ctx.guildId}:${ctx.userId}`, results); return ctx.reply(results.map((x, i) => `${i + 1}. [${x.provider === "soundcloud" ? "SoundCloud" : x.provider === "youtube" ? "YouTube" : "Direct"}] **${x.title}** — ${x.artist}${x.playable === false ? " (search only)" : ""}`).join("\n") || "No results found."); }
        case "pick": { const result = this.searches.get(`${ctx.guildId}:${ctx.userId}`)?.[number(args[0], 1) - 1]; if (!result) return ctx.reply("Search first, then pick a valid result number."); if (result.playable === false) return ctx.reply("That result is search-only and can't be played."); this.players.add(ctx.guildId, [result]); return ctx.reply(`Queued **${result.title}**.`); }
        case "play": case "enqueue": { const query = args.join(" "); if (!query) return ctx.reply("Provide a song, playlist, or link."); if (!ctx.voiceChannelId) return ctx.reply("Join a voice channel first."); const currentVoice = this.players.get(ctx.guildId).voiceChannelId; if (currentVoice && currentVoice !== ctx.voiceChannelId) return ctx.reply("Join Aria's current voice channel first."); const tracks = await this.search.search(query, 1, true); if (!tracks[0]) return ctx.reply("That search is metadata-only; configure a playable provider or provide a direct media URL."); this.feedback?.associate(ctx.guildId, ctx.reply); this.players.setVoiceChannel(ctx.guildId, ctx.voiceChannelId); this.players.add(ctx.guildId, tracks, command === "enqueue"); return ctx.reply(`${command === "enqueue" ? "Playing next" : "Queued"}: **${tracks[0].title}**.`); }
        case "loop": return ctx.reply("Choose a loop mode: **song**, **playlist**, or **off**.", { buttons: ["song", "playlist", "off"] });
        case "toggleloop": { const raw = args.join(" "); const mode: LoopMode = ["s", "song"].includes(raw) ? "song" : ["pl", "playlist"].includes(raw) ? "playlist" : "off"; this.players.setLoop(ctx.guildId, this.players.get(ctx.guildId).loop === mode ? "off" : mode); return ctx.reply(`Loop: **${this.players.get(ctx.guildId).loop}**.`); }
        case "queuelist": { const s = this.players.get(ctx.guildId); const lines = s.queue.slice(s.index, s.index + cfg.queuePageSize).map((x, i) => `${i + s.index + 1}. **${x.title}**${i === 0 ? " ← now" : ""}`); return ctx.reply(lines.join("\n") || "The queue is empty."); }
        case "skip": this.players.skip(ctx.guildId); return ctx.reply("Skipped.");
        case "rewind": this.players.rewind(ctx.guildId); return ctx.reply("Rewound the song.");
        case "reload": { const s = this.players.get(ctx.guildId); const id = s.queue[s.index]?.playlistId; const index = id ? s.queue.findIndex(x => x.playlistId === id) : 0; this.players.playIndex(ctx.guildId, Math.max(0, index)); return ctx.reply("Returned to the beginning of the playlist."); }
        case "restart": this.players.playIndex(ctx.guildId, 0); return ctx.reply("Returned to the beginning of the queue.");
        case "previous": this.players.previous(ctx.guildId); return ctx.reply("Playing the previous song.");
        case "pause": this.players.pause(ctx.guildId); return ctx.reply(this.players.get(ctx.guildId).paused ? "Paused." : "Resumed.");
        case "stop": this.players.stop(ctx.guildId); return ctx.reply("Stopped and left voice.");
        case "stop-remove": this.players.stop(ctx.guildId, true); return ctx.reply("Stopped, cleared the queue, and left voice.");
      }
    } catch (error) { await ctx.reply(`Aria hit a sour note: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
}
