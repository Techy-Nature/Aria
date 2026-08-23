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

test("help lists every command with aliases and the server's current settings", async () => {
  const settings = new SettingsStore();
  settings.update("guild", { prefix: "!", defaultResults: 7, queuePageSize: 12 });
  const router = new CommandRouter(settings, new PlayerManager(), new SearchService());
  const replies: string[] = [];
  const ctx = {
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    reply: async (message: string) => { replies.push(message); },
  };

  await router.handle(ctx, "!h");

  assert.equal(replies.length, 1);
  for (const command of ["help", "prefix", "search", "defresult", "pick", "play", "enqueue", "loop", "toggleloop", "queuelist", "defqueue", "skip", "rewind", "reload", "restart", "previous", "pause", "stop", "stop-remove"]) {
    assert.ok(replies[0].includes(`\`!${command}`), `help should include ${command}`);
  }
  assert.match(replies[0], /Current defaults: prefix `!`, 7 search results, 12 queue entries\./);
  assert.match(replies[0], /`!pause` \(`ps`\)/);
});
