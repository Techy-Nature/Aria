import type { VoiceCredentials } from "./livekit.js";
import { LiveKitVoiceTransport } from "./livekit.js";

export interface FluxerVoiceGateway {
  requestVoice(guildId: string, channelId: string | null, connectionId?: string): void;
  waitForVoiceServer(guildId: string, channelId: string): Promise<VoiceCredentials & { connectionId: string }>;
}
export class FluxerVoiceTransport extends LiveKitVoiceTransport {
  protected readonly label = "Fluxer"; private readonly connectionIds = new Map<string, string>();
  constructor(private readonly gateway: FluxerVoiceGateway) { super(); }
  protected async credentials(guildId: string, channelId: string) { this.gateway.requestVoice(guildId, channelId); const result = await this.gateway.waitForVoiceServer(guildId, channelId); this.connectionIds.set(guildId, result.connectionId); return result; }
  protected async leaveSignaling(guildId: string) { this.gateway.requestVoice(guildId, null, this.connectionIds.get(guildId)); this.connectionIds.delete(guildId); }
}
