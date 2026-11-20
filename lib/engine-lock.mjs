import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

// Magpie can run more than one process that loads plugins (the window's
// gateway host, a CLI that lists providers, a restarted host). Only one of
// them should publish or apply WorkBuddy snapshots on this computer. The
// lock names its holder; a dead or very old holder is taken over.
export async function acquireEngineLock(dir) {
  const file = join(dir, "workbuddy-sync.lock");
  const me = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(me);
      await handle.close();
      return async () => {
        try {
          if ((await readFile(file, "utf8")) === me) await rm(file, { force: true });
        } catch {}
      };
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e?.code)) throw e;
    }
    let holder = null;
    try {
      holder = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    let alive = false;
    if (Number.isInteger(holder?.pid) && holder.host === hostname()) {
      try {
        process.kill(holder.pid, 0);
        alive = true;
      } catch (e) {
        alive = e?.code === "EPERM";
      }
    }
    const old = !holder?.at || Date.now() - Number(holder.at) > 2 * 60 * 60 * 1000;
    if (alive && !old) return null;
    await rm(file, { force: true }).catch(() => {});
  }
  return null;
}
