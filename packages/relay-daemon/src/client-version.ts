/** Release identity from the installed package, shared by the CLI and wire.
 * Resolve the package entry so this also works from compiled test directories.
 * This is independent of the daemon wire protocol version and capabilities.
 */
import { readFileSync } from "node:fs";

const manifest: { version: string } = JSON.parse(readFileSync(
  new URL("../package.json", import.meta.resolve("relay-daemon")), "utf8",
));

export const RELAY_CLIENT_VERSION: string = manifest.version;
