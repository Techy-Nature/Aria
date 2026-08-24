import type { SourceManager } from "../sources/manager.js";
export { UnplayableSourceError } from "../sources/types.js";
export type PlayableSourceResolver = Pick<SourceManager, "resolve">;
export { DirectMediaProvider as DirectMediaResolver } from "../sources/direct.js";
