import test from "node:test";
import assert from "node:assert/strict";
import { CommandRouter } from "./commands.js";
import { PlayerManager } from "./player.js";
import { SearchService } from "./search.js";
import { SettingsStore } from "./store.js";

test("ps aliases the pause command", async () => {
  const players = new PlayerManager();
  const router = new CommandRouter(new SettingsStore(), players, new SearchService());
  const replies: string[] = [];
  const ctx = {
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    reply: async (message: string) => { replies.push(message); },
  };

  await router.handle(ctx, "a!ps");

  assert.equal(players.get(ctx.guildId).paused, true);
  assert.deepEqual(replies, ["Paused."]);
});
