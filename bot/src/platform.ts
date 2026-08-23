import { createInterface } from "node:readline";
import type { CommandContext, PlatformAdapter } from "./types.js";

/** A development adapter for local command testing. */
export class ConsoleAdapter implements PlatformAdapter {
  private input = createInterface({ input: process.stdin, output: process.stdout });
  async start(onMessage: (ctx: CommandContext, content: string) => Promise<void>) {
    console.log("Aria console adapter ready. Type commands such as: a!play yellow submarine");
    this.input.on("line", line => void onMessage({ guildId: "demo", channelId: "console", userId: "local", voiceChannelId: "voice", reply: async message => { console.log(message); } }, line));
  }
  async stop() { this.input.close(); }
}

export { FluxerAdapter } from "./adapters/fluxer.js";
export { StoatAdapter } from "./adapters/stoat.js";
