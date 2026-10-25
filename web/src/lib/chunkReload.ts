/* A deploy replaces every content-hashed chunk, and the web host serves only
   the current build's files. A tab still running the previous build asks for
   a chunk that no longer exists the first time it opens a screen it has not
   loaded yet; the page reloads once onto the new build instead of showing a
   broken screen. */

// Turbopack names its error; the messages are the browsers' own for a
// rejected `import()` and the older webpack runtime's.
const CHUNK_ERROR_MESSAGE =
  /Failed to load chunk|Loading (CSS )?chunk \S+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

export const CHUNK_RELOAD_KEY = "relay.chunkReloadAt";
/** A reload that fails the same way within this window shows the error. */
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

type ReloadStorage = Pick<Storage, "getItem" | "setItem">;

export interface ChunkReloadEnv {
  /** Null when the browser refuses storage: no guard, so no reload. */
  storage: ReloadStorage | null;
  reload: () => void;
  now: number;
}

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_ERROR_MESSAGE.test(error.message);
}

function browserEnv(): ChunkReloadEnv {
  let storage: ReloadStorage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return { storage, reload: () => window.location.reload(), now: Date.now() };
}

/** Reload once for a chunk that a newer deploy removed; false leaves the
    error to the boundary (another kind of error, or a reload just tried). */
export function reloadForChunkError(error: unknown, env: ChunkReloadEnv = browserEnv()): boolean {
  if (!isChunkLoadError(error) || !env.storage) return false;
  const last = Number(env.storage.getItem(CHUNK_RELOAD_KEY));
  if (Number.isFinite(last) && last > 0 && env.now - last < CHUNK_RELOAD_COOLDOWN_MS) return false;
  try {
    env.storage.setItem(CHUNK_RELOAD_KEY, String(env.now));
  } catch {
    return false;
  }
  env.reload();
  return true;
}
