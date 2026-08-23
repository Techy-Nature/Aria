# Aria bot

Aria is a TypeScript music-bot core and JavaScript web player for **Stoat** and **Fluxer**. Its default prefix is `a!`; every server can change its own prefix and search/queue defaults. The core deliberately separates platform gateway/voice transport from commands so the same queue behaves identically on both services.

> **Integration status:** the command engine, state machine, search, API, responsive dashboard, theme system, Fluxer OAuth login, and console development adapter are implemented. The repository does not pretend that a chat message is audio: a production deployment must connect the `PlatformAdapter` contract in `bot/src/types.ts` to the current Stoat and Fluxer gateway/voice SDKs (or Lavalink). `ConsoleAdapter` makes every command and the dashboard runnable while that deployment-specific step is configured.

## Quick start

Requires Node.js 20 or later.

```bash
cp .env.example .env
npm install
npm run dev
```

Register a Fluxer OAuth application, add `http://localhost:3000/api/auth/fluxer/callback` as its redirect URI, and set `FLUXER_CLIENT_ID` and `FLUXER_CLIENT_SECRET`. Then open <http://localhost:3000>. At the terminal, try `a!play yellow submarine`, `a!queuelist`, or `a!skip`. For real YouTube search results, add a YouTube Data API v3 key as `YOUTUBE_API_KEY`; without one, Aria returns safe search-preview links.

## Commands

| Command | Alias | Behavior |
|---|---|---|
| `prefix <prefix>` | `pre` | Change this server's prefix (1–8 characters). |
| `search [count] <terms>` | `sch` | Save a numbered search result list. Count defaults to `defresult`. |
| `defresult <count>` | `dr` | Set default result count (initially 10, maximum 25). |
| `pick <number>` | `pk` | Add a result from your most recent search. |
| `play <terms-or-url>` | `p` | Add a song or playlist to the queue's end. |
| `enqueue <terms-or-url>` | `enq` | Insert immediately after the current song. |
| `loop` | `l` | Show song/playlist/off button choices. |
| `toggleloop song` | `tl s` | Toggle repeat-current-song. |
| `toggleloop playlist` | `tl pl` | Toggle repeat-playlist. |
| `queuelist` | `ql` | Render the queue as a Markdown numbered list with bold titles. |
| `defqueue <count>` | `dq` | Set visible queue entries (initially 10, maximum 25). |
| `skip` | `sk` | Advance to the next track. |
| `rewind` | `rew` | Seek to the current track's beginning. |
| `reload` | `rel` | Return to the current playlist's first entry. |
| `restart` | `re` | Return to the complete queue's first entry. |
| `previous` | `prv` | Play the previous track. |
| `stop` | `s` | Stop and leave voice, retaining the queue. |
| `stop-remove` | `str` | Stop, clear the queue, and leave voice. |
| `pause` | `ps` | Toggle pause without clearing playback state. |

`p` is assigned to `play`, while `ps` toggles pause so the commands have distinct aliases.

## Platform deployment

1. Create a Fluxer bot and OAuth application, then keep credentials only in `.env`/your host's secret manager. Set `PUBLIC_URL` to the backend's public origin and, when separately hosted, `DASHBOARD_URL` to the dashboard origin. The registered callback is `<PUBLIC_URL>/api/auth/fluxer/callback`.
2. Implement `PlatformAdapter.start()` to normalize incoming message events to `CommandContext`. Map button interaction values (`song`, `playlist`, `off`) to `PlayerManager.setLoop()`.
3. Attach the platform's voice implementation or a Lavalink node to player change events. Resolve playlist links into individual `Track` objects and report actual duration/position.
4. Extend the Fluxer login's authorization model to determine the shared guild plus the user's voice channel before accepting controls. Stoat dashboard login remains disabled until Stoat publishes an OAuth application registration flow.
5. Use a durable database implementation for `SettingsStore` when deploying more than one process.

The `ARIA_TOKEN` and `ARIA_PLATFORM` environment values are reserved for the selected production adapter. The bot API must run on a persistent Node host; GitHub Pages hosts only the dashboard.

## Architecture

* `bot/src/commands.ts` — prefix parser, aliases, validation, and user replies.
* `bot/src/player.ts` — deterministic per-guild queues, history, loop modes, and controls.
* `bot/src/search.ts` — links, previews, and YouTube API search.
* `bot/src/server.ts` — authenticated JSON API and static dashboard host.
* `bot/src/platform.ts` — local adapter and production adapter seam.
* `dashboard/` — dependency-free GitHub Pages compatible player. See [dashboard documentation](dashboard/DASHBOARD_README.md).

## Build and test

```bash
npm run build
npm test
```

## Security notes

Fluxer login uses authorization-code OAuth with state, PKCE, provider-side account verification, short-lived opaque server sessions, and HTTP-only cookies. Production still needs durable shared session storage, authorization checks for every guild action, HTTPS, rate limits, and input limits. Configure a single trusted `DASHBOARD_URL`; do not use a wildcard CORS origin with credentials. Media playback must comply with the source service's terms and applicable copyright law.

## License

See [LICENSE](LICENSE).
