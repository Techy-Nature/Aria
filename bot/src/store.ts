import type { GuildSettings } from "./types.js";

export class SettingsStore {
  private readonly values = new Map<string, GuildSettings>();
  constructor(private readonly initialPrefix = "a!") {}
  get(guildId: string): GuildSettings {
    const found = this.values.get(guildId);
    if (found) return found;
    const value = { prefix: this.initialPrefix, defaultResults: 10, queuePageSize: 10 };
    this.values.set(guildId, value);
    return value;
  }
  update(guildId: string, patch: Partial<GuildSettings>) { Object.assign(this.get(guildId), patch); }
}
