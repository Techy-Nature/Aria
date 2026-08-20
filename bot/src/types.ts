export type LoopMode = "off" | "song" | "playlist";
export interface Track { id: string; title: string; url: string; artist: string; duration: number; artwork?: string; playlistId?: string }
export interface GuildSettings { prefix: string; defaultResults: number; queuePageSize: number }
export interface PlayerState { guildId: string; voiceChannelId?: string; queue: Track[]; history: Track[]; index: number; paused: boolean; position: number; loop: LoopMode }
export interface CommandContext {
  guildId: string; channelId: string; userId: string; voiceChannelId?: string;
  reply(message: string, components?: unknown): Promise<void>;
}
export interface PlatformAdapter {
  start(onMessage: (ctx: CommandContext, content: string) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
