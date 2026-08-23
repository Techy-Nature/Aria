# Aria bot

Aria is a TypeScript music-bot core and JavaScript web player for **Stoat** and **Fluxer**. Its default prefix is `a!`; every server can change its own prefix and search/queue defaults. The core deliberately separates platform gateway/voice transport from commands so the same queue behaves identically on both services.

> **Integration status:** the command engine, dashboard, Fluxer OAuth login, and Fluxer/Stoat text gateway adapters are implemented. Voice/audio transport is deliberately not implemented yet; queue commands update Aria's player state but do not play audio.

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
| `help` | `h` | Show every command, alias, usage, and the server's current settings. |
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

Set these Render environment variables (the platform name is case-insensitive):

```env
ARIA_PLATFORM=fluxer
ARIA_TOKEN=<Fluxer bot token>
ARIA_PREFIX=a!
```

or:

```env
ARIA_PLATFORM=stoat
ARIA_TOKEN=<Stoat bot token>
ARIA_PREFIX=a!
```

Use `ARIA_PLATFORM=console` (or omit it) for local terminal development. Selecting Fluxer or Stoat without `ARIA_TOKEN` intentionally fails startup rather than starting an offline console bot. Never expose the token in logs.

`ARIA_TOKEN` authenticates the **chat bot connection**. It is unrelated to `FLUXER_CLIENT_ID` and `FLUXER_CLIENT_SECRET`, which remain the OAuth application credentials used for **dashboard user login**. Set `PUBLIC_URL` to the backend's public origin and `DASHBOARD_URL` to the dashboard origin; the OAuth callback is `<PUBLIC_URL>/api/auth/fluxer/callback`.

Fluxer uses an unprefixed token in gateway `IDENTIFY`/`RESUME` payloads and `Authorization: Bot <token>` for REST message sends. The exact opcode values come from Fluxer's [`packages/constants/src/GatewayConstants.ts`](https://github.com/fluxerapp/fluxer/blob/main/packages/constants/src/GatewayConstants.ts), while HELLO, IDENTIFY, heartbeat, and RESUME payload behavior follows [`fluxer_app/src/features/gateway/transport/GatewaySocket.ts`](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/gateway/transport/GatewaySocket.ts). REST message sending follows Fluxer's [`MessageController.ts`](https://github.com/fluxerapp/fluxer/blob/main/fluxer_api/src/api/channel/controllers/MessageController.ts).

Stoat connects to event protocol v1 JSON, authenticates with the token, sends 30-second Ping events, and uses `X-Bot-Token` for REST. Stoat self-user identification deliberately follows the official client's Ready handler: [`src/events/v1.ts`](https://github.com/stoatchat/javascript-client-sdk/blob/main/src/events/v1.ts) assigns the Ready user whose `relationship` is `User` as the current session user, and the current API schema defines that value as the user's relationship to themselves. Connection authentication and Ping behavior follow [`src/events/EventClient.ts`](https://github.com/stoatchat/javascript-client-sdk/blob/main/src/events/EventClient.ts).

The adapters cache gateway voice-state events when supplied, so `voiceChannelId` is best-effort and may be undefined until the relevant state has been observed. Voice/audio playback remains future work. Stoat DMs are ignored because they have no server ID; Fluxer messages from bots and Stoat webhook messages are ignored. For multi-process deployment, replace the in-memory `SettingsStore` with durable shared storage.

## Architecture

* `bot/src/commands.ts` — prefix parser, aliases, validation, and user replies.
* `bot/src/player.ts` — deterministic per-guild queues, history, loop modes, and controls.
* `bot/src/search.ts` — links, previews, and YouTube API search.
* `bot/src/server.ts` — authenticated JSON API and static dashboard host.
* `bot/src/adapters/` — Fluxer and Stoat text gateway/REST adapters.
* `bot/src/platform.ts` — local console adapter and adapter exports.
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
