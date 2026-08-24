import test from "node:test";
import assert from "node:assert/strict";
import { CommandRouter } from "./commands.js";
import { PlayerManager } from "./player.js";
import { SearchService } from "./search.js";
import { SettingsStore } from "./store.js";
import { SourceManager } from "./sources/manager.js";
import { YouTubeProvider } from "./sources/youtube.js";

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

test("play requires the caller to join a known voice channel", async () => {
  const router = new CommandRouter(new SettingsStore(), new PlayerManager(), new SearchService());
  const replies: string[] = [];
  await router.handle({ guildId: "guild", channelId: "text", userId: "user", reply: async message => { replies.push(message); } }, "a!play https://media.example/song.mp3");
  assert.deepEqual(replies, ["Join a voice channel first."]);
});

test("metadata-only search is rejected before play is reported successful", async () => {
  const players = new PlayerManager(); const router = new CommandRouter(new SettingsStore(), players, new SearchService("")); const replies: string[] = [];
  await router.handle({ guildId: "guild", channelId: "text", userId: "user", voiceChannelId: "voice", reply: async message => { replies.push(message); } }, "a!play Yellow Submarine");
  assert.match(replies[0], /metadata-only.*direct media URL/i); assert.equal(players.get("guild").queue.length, 0);
});

test("pick rejects a metadata-only YouTube search result", async () => {
  const youtube = new YouTubeProvider("key", async () => new Response(JSON.stringify({ items: [{ id: { videoId: "video" }, snippet: { title: "Search result", channelTitle: "Artist" } }] }), { status: 200 }));
  const search = new SearchService(undefined, new SourceManager([youtube])); const players = new PlayerManager(); const router = new CommandRouter(new SettingsStore(), players, search); const replies: string[] = [];
  const ctx = { guildId: "guild", channelId: "text", userId: "user", reply: async (message: string) => { replies.push(message); } };
  await router.handle(ctx, "a!search song"); await router.handle(ctx, "a!pick 1");
  assert.equal(replies[1], "That result is search-only and can't be played."); assert.equal(players.get("guild").queue.length, 0);
});

test("a direct HTTP media URL is accepted into voice playback state", async () => {
  const players = new PlayerManager(); const router = new CommandRouter(new SettingsStore(), players, new SearchService()); const replies: string[] = [];
  await router.handle({ guildId: "guild", channelId: "text", userId: "user", voiceChannelId: "voice", reply: async message => { replies.push(message); } }, "a!play https://media.example/song.mp3");
  assert.match(replies[0], /^Queued:/); assert.equal(players.get("guild").queue[0].url, "https://media.example/song.mp3"); assert.equal(players.get("guild").voiceChannelId, "voice");
});
