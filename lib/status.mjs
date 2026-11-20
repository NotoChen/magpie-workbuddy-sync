import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The sandboxed Magpie page cannot reach the network. It reads a snapshot
// the host writes beside it, the way WorkBuddy Plus's page does.
export async function writePageStatus(pluginDir, status) {
  const pageDir = join(pluginDir, "page");
  await mkdir(pageDir, { recursive: true });
  const file = join(pageDir, "data.js");
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const safe = {
    ...status,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(temp, `globalThis.WORKBUDDY_SYNC = ${JSON.stringify(safe)};\n`, { mode: 0o600 });
  await rename(temp, file).catch(async () => {
    await writeFile(file, `globalThis.WORKBUDDY_SYNC = ${JSON.stringify(safe)};\n`, { mode: 0o600 });
  });
}
