import type { Track } from "../types.js";
import { UnplayableSourceError, type MediaProvider, type PlayableMedia } from "./types.js";

const WEBPAGE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|pixabay\.com)$/i;
export class DirectMediaProvider implements MediaProvider {
  readonly id = "direct" as const; readonly supportsPlayback = true;
  canHandle(input: string) { try { return ["http:", "https:"].includes(new URL(input).protocol) && !WEBPAGE_HOSTS.test(new URL(input).hostname); } catch { return false; } }
  async fromUrl(input: string): Promise<Track> {
    if (!this.canHandle(input)) throw new UnplayableSourceError("only direct HTTP(S) media URLs are supported.");
    return { id: input, title: "Linked media", url: input, webUrl: input, artist: "Direct media", duration: 0, provider: "direct", playable: true };
  }
  async resolve(track: Track, positionSeconds = 0): Promise<PlayableMedia> {
    if (!this.canHandle(track.url)) throw new UnplayableSourceError("this result does not contain a playable direct HTTP(S) media URL.");
    return { track, inputUrl: new URL(track.url).toString(), positionSeconds, provider: "direct", ephemeral: false };
  }
}
