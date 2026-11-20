import { copyFile, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function acquireLock(file) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (let wait = 10; ; wait = Math.min(wait * 2, 500)) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      return async () => rm(lock, { force: true }).catch(() => {});
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e?.code)) throw e;
    }
    const info = await stat(lock).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 10_000) {
      await rm(lock, { force: true }).catch(() => {});
      continue;
    }
    if (Date.now() - start > 20_000) throw new Error("timed out waiting for logins.json.lock");
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// A follower's fresh access token must be allowed to try. Magpie keeps a
// per-account "lapsed" mark in logins.json when a request was refused; a
// mark left from before a new snapshot would keep the account out of
// routing even though the new token is good. Clear it only for the
// WorkBuddy accounts whose token was just applied.
export async function clearWorkBuddyLapse(file, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return false;
  let exists = true;
  try {
    await readFile(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") exists = false;
    else throw e;
  }
  if (!exists) return false;
  const wanted = new Set(keys);
  let changed = false;
  const unlock = await acquireLock(file);
  try {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") return false;
      throw e;
    }
    let list;
    try {
      list = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      return false;
    }
    if (!Array.isArray(list)) return false;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.agent !== "plugin:workbuddy" && entry.agent !== "plugin:workbuddy-ai") continue;
      if (!wanted.has(entry.home)) continue;
      if ("lapsed" in entry) {
        delete entry.lapsed;
        changed = true;
      }
      if ("refused" in entry) {
        delete entry.refused;
        changed = true;
      }
    }
    if (!changed) return false;
    await copyFile(file, `${file}.bak`).catch(() => {});
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
    const handle = await open(temp, "r+");
    await handle.sync();
    await handle.close();
    try {
      await rename(temp, file);
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e?.code)) throw e;
      await rm(file, { force: true });
      await rename(temp, file);
    }
    return true;
  } finally {
    await unlock();
  }
}
