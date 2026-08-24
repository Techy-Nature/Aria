import type { CommandContext } from "../types.js";

export class PlaybackFeedback {
  private readonly replies = new Map<string, CommandContext["reply"]>();
  associate(guildId: string, reply: CommandContext["reply"]) { this.replies.set(guildId, reply); }
  async report(guildId: string, message: string) { try { await this.replies.get(guildId)?.(message); } catch (error) { console.error(`[Voice] Could not send playback error: ${error instanceof Error ? error.message : String(error)}`); } }
}
