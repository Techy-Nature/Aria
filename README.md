# Aria bot

Aria is a TypeScript music-bot core and JavaScript web player for **Stoat** and **Fluxer**. Its default prefix is `a!`; every server can change its own prefix and search/queue defaults. The core deliberately separates platform gateway/voice transport from commands so the same queue behaves identically on both services.

> **Integration status:** text and voice are implemented for Fluxer and Stoat. Voice uses each service's current LiveKit assignment flow and a shared FFmpeg decoder; console mode remains intentionally voice-free.

## Quick start

Requires Node.js 20 or later.

```bash
cp .env.example .env
npm install
npm run dev
```

Register a Fluxer OAuth application, add `http://localhost:3000/api/auth/fluxer/callback` as its redirect URI, and set `FLUXER_CLIENT_ID` and `FLUXER_CLIENT_SECRET`. Then open <http://localhost:3000>. At the terminal, try `a!play sc: yellow submarine`, `a!queuelist`, or `a!skip`.

## Media providers

Provider behavior is deliberately split between stable search/queue metadata and playback-time resolution. This prevents an expiring signed stream from sitting in a queue or appearing in the dashboard.

| Provider | Search | Playback |
|---|---:|---:|
| Direct HTTP(S) URL | No | Yes |
| SoundCloud | Yes | Yes, public off-platform-streamable tracks |
| YouTube | Yes | Yes, via yt-dlp |
| YouTube Music | Via YouTube | Yes, via yt-dlp |
| Radio stream | No | Yes, via FFmpeg |
| Pixabay | No* | Direct media URLs only |

SoundCloud requires `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET`. Create an application through SoundCloud, keep both values in deployment secrets, and use credentials authorized for its [official public API](https://developers.soundcloud.com/docs/api/guide). Aria authenticates the initial OAuth client-credentials exchange with HTTP Basic authentication, caches the resulting access token, and uses SoundCloud's documented form-authenticated refresh grant to replace each single-use refresh token before expiry (falling back to a new client-credentials exchange only when refresh is unavailable or rejected). Search explicitly requests SoundCloud's linked-partition response format and consumes its first `collection`. Stable queue entries use the complete SoundCloud track URN; public track pages are resolved through the API, and the current stream is requested only when playback starts. Aria prefers `hls_aac_160_url`, falls back to `hls_aac_96_url`, and sends that temporary AAC HLS input directly to FFmpeg. Tokens, authorization headers, secrets, and signed HLS inputs never enter a `Track` or public player snapshot.

YouTube search and playlist importing require `YOUTUBE_API_KEY` and use the official YouTube Data API. Results retain stable video identity, canonical URL, channel, and artwork. `play` appends imported playlist videos to the queue; `enqueue` inserts them, in order, immediately after the current song. Imports stop after 150 available videos or three API pages, whichever comes first; private and deleted entries do not count toward the 150-track limit. Explicit `/playlist?list=...` links import playlists, while watch and `youtu.be` links remain single videos even when they also contain a `list` parameter. Each item keeps its playlist identity for queue controls. At the moment each queued video begins, the reusable yt-dlp resolver obtains an ephemeral audio URL and required HTTP headers for the existing FFmpeg pipeline. YouTube Music uses the same `youtube` queue identity.

Playback requires a reasonably current [yt-dlp](https://github.com/yt-dlp/yt-dlp) executable. Set `YTDLP_PATH` for a custom executable, otherwise Aria uses `yt-dlp` from `PATH`. Aria never installs or auto-updates it at runtime. YouTube delivery changes can temporarily break extraction, particularly on Render and other datacenter IPs.

Set `YTDLP_PO_TOKEN_ENABLED=true` to make anonymous proof-of-origin-token playback the first strategy. Following yt-dlp's current [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide), Aria requests the `mweb` client with `--extractor-args youtube:player_client=mweb` and explicitly selects the featured [BgUtils PO Token Provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) script with a separate `--extractor-args youtubepot-bgutilscript:script_path=...`. `BGUTIL_SCRIPT_PATH` overrides the absolute generator path; the Docker default is `/root/bgutil-ytdlp-pot-provider/server/build/generate_once.js`. Aria enables this strategy only when the Python plugin, generator file, and Node.js runtime all exist. No Google account, browser profile, manually pasted token, or cookies are required or supported. If the plugin or token generation is unavailable, Aria makes at most one normal yt-dlp attempt; private, removed, geo-restricted, and timed-out videos do not receive a pointless fallback attempt. Only explicitly allowlisted YouTube hosts are passed to fixed yt-dlp arguments, and tokens, visitor data, signed URLs, and headers are never logged or stored in queue/dashboard state.

The Docker image enables this mode by default. It pins and installs yt-dlp and the provider's Python plugin from PyPI at build time, then checks out the matching tagged BgUtils generation script and builds it with the already-present Node runtime at the provider's documented default location. Native/non-Docker installations may leave the variable unset for standard yt-dlp behavior, or install both provider components according to the provider documentation before enabling it. YouTube actively changes its enforcement, and a PO token cannot guarantee that a challenged server IP will work; maintainers may need to update the pinned yt-dlp/provider versions after reviewing upstream releases. Authenticated, private, age-gated, geo-restricted, and DRM-protected media may remain unavailable.

Aria currently uses BgUtils **script mode**. Upstream also offers a simpler, faster HTTP mode for repeated or high-concurrency requests (`youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416`), while script mode starts Node for each yt-dlp invocation. HTTP mode is not launched by this release: adopting it later requires supervised lifecycle management and binding port 4416 only to localhost, never publishing it publicly.

Pixabay's [official API documentation](https://pixabay.com/api/docs/) documents image and video search, not a supported music/audio API. Aria consequently has no native Pixabay provider and does not scrape its site or use internal endpoints. An actual authorized HTTP(S) audio URL can still use the direct provider.

Examples: `a!play https://media.example/song.aac`, `a!play sc: song title`, `a!search soundcloud: song title`, and `a!search youtube: song title`. Plain `a!play song title` considers playback-capable search providers, while plain `a!search song title` can include metadata-only results.

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

The adapters cache gateway voice-state events when supplied, so `voiceChannelId` is best-effort and may be undefined until the relevant state has been observed. Stoat DMs are ignored because they have no server ID; Fluxer messages from bots and Stoat webhook messages are ignored. For multi-process deployment, replace the in-memory `SettingsStore` with durable shared storage.

## Voice and audio

`PlaybackCoordinator` observes `PlayerManager` intent and owns no queue rules. A separate playable-source resolver distinguishes metadata links from decoder inputs before queueing, and a guild feedback sink reports safe connection/decoder failures to the originating text channel. Per-guild transport sessions isolate LiveKit rooms, FFmpeg decoders, pause state, and playback generations. Generation checks discard EOF from a manually stopped or superseded decoder, preventing double advances. `stop` tears down the decoder, LiveKit room, and platform signaling; process shutdown tears down every guild.

Fluxer joining follows its official gateway opcode 4 voice-state payload, including `connection_id`, then consumes `VOICE_SERVER_UPDATE` (`endpoint`, ephemeral `token`, and `connection_id`) and publishes PCM audio with the official LiveKit Node SDK. The implementation was checked against [`GatewayConstants.ts`](https://github.com/fluxerapp/fluxer/blob/main/packages/constants/src/GatewayConstants.ts), [`VoiceChannelConnector.tsx`](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/voice/engine/VoiceChannelConnector.tsx), [`GatewayVoiceTypes.ts`](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/gateway/types/GatewayVoiceTypes.ts), and [`VoiceServerUpdate.ts`](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/voice/events/VoiceServerUpdate.ts). Connect/Speak denial is surfaced by Fluxer's `VOICE_PERMISSION_DENIED` gateway error rather than using Discord RTP.

Stoat uses the current native `POST /channels/:id/join_call` assignment and returned LiveKit URL/token, matching current [Revoice.js](https://www.npmjs.com/package/revoice.js) behavior. Aria uses `@livekit/rtc-node` directly rather than Revoice's bundled FFmpeg layer because this keeps one audited decoder, avoids Revoice's process-global signal handler/debug logging, and reuses Aria's existing bot authentication. A 403 produces a connect/speak permission error.

The shared decoder accepts provider-resolved, authorized HTTP(S) media URLs and safely spawns `ffmpeg` with a fixed argv array (never a shell). It emits 48 kHz stereo signed 16-bit PCM into LiveKit. An awaited stream pump and Node high-water mark bound decoded PCM while LiveKit is slow; `-re` adds real-time input pacing. Pause/resume sends SIGSTOP/SIGCONT; replacement, stop, disconnect, and shutdown abort the pump and terminate the child so old frames cannot leak into a replacement track. `FFMPEG_PATH` can override the executable. Use only media you are entitled to stream.

### Render requirements

Use a Render **Docker** service with the repository's `Dockerfile` (recommended); it installs Node 22, FFmpeg, pinned yt-dlp, and the pinned BgUtils provider plugin/generator entirely at build time. Alternatively install the executables and optional provider components in a native service image. Leave `FFMPEG_PATH` and `YTDLP_PATH` unset for executables on `PATH`, or point them at explicitly installed locations; set `YTDLP_PO_TOKEN_ENABLED=true` only when the provider components are installed. Aria does not download or update binaries at startup, and no binary is committed. Voice needs a continuously running instance and outbound HTTPS/WebSocket/WebRTC/UDP connectivity. A free service may spin down, restart, throttle CPU, or lack stable UDP, interrupting continuous voice; use an always-on instance for reliable playback. No Lavalink or additional hosted service is required.

### Deployment smoke tests

For Fluxer, set `ARIA_PLATFORM=fluxer`, deploy, join a voice channel, and run `a!play https://your-authorized-host/example.mp3`. Confirm join/audio, `a!pause` twice, `a!skip`, and `a!stop`; finally search Render logs and confirm that no LiveKit token or signed media URL appears. Repeat with `ARIA_PLATFORM=stoat`. Also confirm the bot has the platform's connect/speak permissions in the target channel. Test only sources you are authorized to transmit.

Ephemeral voice credentials live only in method-local values and the LiveKit SDK. They are never added to player state, API responses, or logs. Logs intentionally print track titles but not source URLs, authorization headers, bot tokens, or LiveKit tokens.

## Architecture

* `bot/src/commands.ts` — prefix parser, aliases, validation, and user replies.
* `bot/src/player.ts` — deterministic per-guild queues, history, loop modes, and controls.
* `bot/src/sources/` — provider contract, detection/search routing, direct URLs, SoundCloud OAuth/API/HLS resolution, and YouTube metadata.
* `bot/src/search.ts` — compatibility facade over the provider-neutral source manager.
* `bot/src/server.ts` — authenticated JSON API and static dashboard host.
* `bot/src/adapters/` — Fluxer and Stoat text gateway/REST adapters.
* `bot/src/voice/` — shared coordinator/decoder and platform-native LiveKit transports.
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
