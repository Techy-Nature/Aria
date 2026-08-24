export type LoopMode = "off" | "song" | "playlist";
export type MediaProviderId = "direct" | "soundcloud" | "youtube";
export interface Track {
  id: string; title: string; url: string; artist: string; duration: number; artwork?: string; playlistId?: string;
  /** Stable public metadata only. Never put credentials or temporary stream URLs here. */
  provider?: MediaProviderId; providerId?: string; webUrl?: string; playable?: boolean;
  attribution?: { service: string; uploaderUrl?: string };
}
export interface GuildSettings { prefix: string; defaultResults: number; queuePageSize: number }
export interface PlayerState { guildId: string; voiceChannelId?: string; queue: Track[]; history: Track[]; index: number; paused: boolean; position: number; loop: LoopMode; playbackRevision: number }
export interface CommandContext {
  guildId: string; channelId: string; userId: string; voiceChannelId?: string;
  reply(message: string, components?: unknown): Promise<void>;
}
export interface PlatformAdapter {
  readonly voice?: import("./voice/types.js").VoiceTransport;
  start(onMessage: (ctx: CommandContext, content: string) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
