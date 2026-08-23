import { LiveKitVoiceTransport } from "./livekit.js";
import type { VoiceCredentials } from "./livekit.js";

const API = "https://api.stoat.chat";
export class StoatVoiceTransport extends LiveKitVoiceTransport {
  protected readonly label = "Stoat";
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) { super(); }
  protected async credentials(_guildId: string, channelId: string): Promise<VoiceCredentials> {
    const response = await this.fetcher(`${API}/channels/${encodeURIComponent(channelId)}/join_call`, { method: "POST", headers: { "X-Bot-Token": this.token, "Content-Type": "application/json" }, body: JSON.stringify({ node: "worldwide" }) });
    if (!response.ok) { if (response.status === 403) throw new Error("Missing permission to connect or speak in that voice channel."); throw new Error(`Stoat voice join failed (${response.status}).`); }
    const value = await response.json() as { token?: unknown; url?: unknown };
    if (typeof value.token !== "string" || typeof value.url !== "string") throw new Error("Stoat did not return LiveKit voice credentials.");
    return { token: value.token, endpoint: value.url };
  }
}
