import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncEngine } from "./lib/sync.mjs";

const pluginDir = dirname(fileURLToPath(import.meta.url));

// Magpie starts this function in its plugin host. The plugin has no provider
// of its own: it is a companion to @magpie-community/opencode-workbuddy-auth,
// and only moves WorkBuddy auth entries through the same GitHub repository
// Magpie's own sync already uses.
export const WorkBuddySyncPlugin = async (input = {}, options = {}) => {
  const dir = String(input.directory || process.env.MAGPIE_CONFIG_DIR || process.cwd());
  const engine = new SyncEngine({
    dir,
    pluginDir,
    options,
    log: (line) => console.error(line),
  });
  engine.start().catch((error) => console.error(`[workbuddy-sync] ${error instanceof Error ? error.message : error}`));
  return {};
};

export default WorkBuddySyncPlugin;
