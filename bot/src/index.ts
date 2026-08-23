import "dotenv/config";
import { createAdapter } from "./adapterFactory.js"; import { CommandRouter } from "./commands.js"; import { PlayerManager } from "./player.js"; import { SearchService } from "./search.js"; import { createServer } from "./server.js"; import { SettingsStore } from "./store.js";
import { PlaybackCoordinator } from "./voice/manager.js";
const players = new PlayerManager(); const search = new SearchService(); const router = new CommandRouter(new SettingsStore(process.env.ARIA_PREFIX), players, search); const adapter = createAdapter();
const playback = adapter.voice ? new PlaybackCoordinator(players, adapter.voice) : undefined;
await adapter.start((ctx, content) => router.handle(ctx, content));
const server = createServer(players, search).listen(Number(process.env.PORT ?? 3000), () => console.log(`Dashboard: http://localhost:${process.env.PORT ?? 3000}`));
let shuttingDown = false;
async function shutdown(signal: string) { if (shuttingDown) return; shuttingDown = true; console.log(`Received ${signal}; shutting down`); await playback?.shutdown(); await adapter.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on("SIGTERM", () => void shutdown("SIGTERM")); process.on("SIGINT", () => void shutdown("SIGINT"));
