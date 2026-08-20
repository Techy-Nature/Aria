import "dotenv/config";
import { CommandRouter } from "./commands.js"; import { ConsoleAdapter } from "./platform.js"; import { PlayerManager } from "./player.js"; import { SearchService } from "./search.js"; import { createServer } from "./server.js"; import { SettingsStore } from "./store.js";
const players = new PlayerManager(); const search = new SearchService(); const router = new CommandRouter(new SettingsStore(process.env.ARIA_PREFIX), players, search); const adapter = new ConsoleAdapter();
await adapter.start((ctx, content) => router.handle(ctx, content));
createServer(players, search).listen(Number(process.env.PORT ?? 3000), () => console.log(`Dashboard: http://localhost:${process.env.PORT ?? 3000}`));
