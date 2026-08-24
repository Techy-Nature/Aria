import { SourceManager } from "./sources/manager.js";
import { DirectMediaProvider } from "./sources/direct.js";
import { YouTubeProvider } from "./sources/youtube.js";
/** Compatibility facade: provider-specific search now lives in SourceManager. */
export class SearchService {
  readonly sources: SourceManager;
  constructor(apiKey = process.env.YOUTUBE_API_KEY, sources?: SourceManager) { this.sources = sources ?? new SourceManager([new YouTubeProvider(apiKey), new DirectMediaProvider()]); }
  search(query: string, limit: number, playableOnly = false) { return this.sources.search(query, limit, playableOnly); }
}
