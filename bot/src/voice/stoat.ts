import { LiveKitVoiceTransport } from "./livekit.js";
import type { VoiceCredentials } from "./livekit.js";

const API = "https://api.stoat.chat";

/** Reads the voice node names Stoat lists at its API root (features.livekit.nodes[].name). */
export function voiceNodeNames(config: unknown): string[] {
  const features = (config as { features?: { livekit?: { nodes?: unknown } } } | null)?.features;
  const nodes = features?.livekit?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap(node => {
    const name = (node as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.trim() ? [name] : [];
  });
}

export class StoatVoiceTransport extends LiveKitVoiceTransport {
  protected readonly label = "Stoat";
  private node?: Promise<string | undefined>;
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) { super(); }
  /**
   * The voice node to ask for. Stoat names its nodes at its API root (currently "hel1"); asking for a
   * node it doesn't have fails, so Aria reads the list instead of hard-coding a name. If the list can't
   * be read, Aria leaves the node out and lets Stoat choose, and tries the list again next time.
   */
  private voiceNode(): Promise<string | undefined> {
    this.node ??= (async () => {
      try {
        const response = await this.fetcher(`${API}/`, { headers: { Accept: "application/json" } });
        if (!response.ok) return undefined;
        return voiceNodeNames(await response.json())[0];
      } catch { return undefined; }
    })().then(node => { if (!node) this.node = undefined; return node; });
    return this.node;
  }
  protected async credentials(_guildId: string, channelId: string): Promise<VoiceCredentials> {
    const node = await this.voiceNode();
    const response = await this.fetcher(`${API}/channels/${encodeURIComponent(channelId)}/join_call`, { method: "POST", headers: { "X-Bot-Token": this.token, "Content-Type": "application/json" }, body: JSON.stringify(node ? { node } : {}) });
    if (!response.ok) {
      if (response.status === 403) throw new Error("Missing permission to connect or speak in that voice channel.");
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      console.error(`[Stoat] Voice join failed (${response.status}${node ? `, node ${node}` : ""})${detail ? `: ${detail}` : ""}`);
      throw new Error(`Stoat voice join failed (${response.status}).`);
    }
    const value = await response.json() as { token?: unknown; url?: unknown };
    if (typeof value.token !== "string" || typeof value.url !== "string") throw new Error("Stoat did not return LiveKit voice credentials.");
    return { token: value.token, endpoint: value.url };
  }
}
