import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const WORKBUDDY_PROVIDERS = ["workbuddy", "workbuddy-ai"];

export function isWorkBuddyKey(key) {
  return WORKBUDDY_PROVIDERS.some((provider) => key === provider || key.startsWith(`${provider}#`));
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseAuth(text) {
  const value = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  if (!isObject(value)) throw new Error("plugin-auth.json is not a JSON object");
  return value;
}

export async function readAuthFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
  try {
    return parseAuth(text);
  } catch {
    // Magpie keeps a last good generation beside it; use that rather than
    // treating an unreadable file as empty and writing over it.
    const backup = await readFile(`${file}.bak`, "utf8").catch(() => null);
    if (backup === null) throw new Error("plugin-auth.json does not parse and has no readable .bak");
    return parseAuth(backup);
  }
}

// The accounts a master publishes. Desktop sign-ins are markers into the
// local WorkBuddy app, not credentials this plugin can carry; they stay on
// the master. API keys are not rotating, so they can travel as they are.
export function collectWorkBuddy(auth) {
  const out = {};
  for (const key of sortKeys(Object.keys(auth).filter(isWorkBuddyKey))) {
    const value = auth[key];
    if (!isObject(value)) continue;
    if (value.type === "api" && typeof value.key === "string" && value.key) {
      out[key] = { ...value };
      continue;
    }
    if (value.type !== "oauth" || typeof value.access !== "string" || !value.access) continue;
    if (value.source === "desktop") continue;
    out[key] = { ...value };
  }
  return out;
}

// What a follower stores: the access token and the fields that identify
// the account, never a refresh token. expires is 0 on purpose: both the
// Magpie host and the official WorkBuddy plugin then treat the sign-in as
// not due for renewal, and the plugin's 401 path has nothing to spend.
export function materialize(accounts) {
  const out = {};
  for (const key of sortKeys(Object.keys(accounts || {}).filter(isWorkBuddyKey))) {
    const value = accounts[key];
    if (!isObject(value)) continue;
    if (value.type === "api" && typeof value.key === "string" && value.key) {
      out[key] = { type: "api", key: value.key };
      continue;
    }
    if (value.type !== "oauth" || typeof value.access !== "string" || !value.access) continue;
    const entry = {
      type: "oauth",
      access: value.access,
      expires: 0,
    };
    for (const field of ["uid", "accountId", "domain", "tokenType", "enterpriseId", "plan"]) {
      if (typeof value[field] === "string" && value[field]) entry[field] = value[field];
    }
    out[key] = entry;
  }
  return out;
}

// Replace this computer's WorkBuddy entries with the master's, keeping every
// other provider's entries byte-for-byte in the JSON object.
export function mergeForSlave(current, remoteAccounts) {
  const out = {};
  for (const [key, value] of Object.entries(current)) {
    if (!isWorkBuddyKey(key)) out[key] = value;
  }
  const desired = materialize(remoteAccounts);
  for (const key of sortKeys(Object.keys(desired))) out[key] = desired[key];
  return out;
}

// Remove anything that could let a follower refresh, even if a person just
// signed in through Magpie's UI or the official plugin wrote a new entry.
export function enforceSlave(auth) {
  const out = {};
  for (const [key, value] of Object.entries(auth)) {
    if (!isWorkBuddyKey(key) || !isObject(value)) {
      out[key] = value;
      continue;
    }
    if (value.type === "api" && typeof value.key === "string" && value.key) {
      out[key] = { type: "api", key: value.key };
      continue;
    }
    if (value.type !== "oauth" || typeof value.access !== "string" || !value.access || value.source === "desktop") {
      continue;
    }
    const entry = { ...value, type: "oauth", expires: 0 };
    delete entry.refresh;
    delete entry.refreshExpiresAt;
    delete entry.source;
    out[key] = entry;
  }
  return out;
}

export function countWorkBuddy(auth) {
  return Object.keys(auth).filter(isWorkBuddyKey).length;
}

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortKeys(keys) {
  const rank = (key) => {
    if (key === "workbuddy") return 0;
    if (key.startsWith("workbuddy#")) return 1;
    if (key === "workbuddy-ai") return 2;
    if (key.startsWith("workbuddy-ai#")) return 3;
    return 4;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

async function acquireLock(file) {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (let wait = 10; ; wait = Math.min(wait * 2, 500)) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await rm(lock, { force: true }).catch(() => {});
      };
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e?.code)) throw e;
    }
    const info = await stat(lock).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 10_000) {
      await rm(lock, { force: true }).catch(() => {});
      continue;
    }
    if (Date.now() - start > 20_000) throw new Error("timed out waiting for plugin-auth.json.lock");
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// writeAuthFile changes plugin-auth.json under the same lock Magpie's host
// uses, after re-reading it, and replaces it by rename. It never writes when
// the current file cannot be read.
export async function writeAuthFile(file, change) {
  const unlock = await acquireLock(file);
  try {
    const current = await readAuthFile(file);
    const before = JSON.stringify(current);
    const next = change(current);
    if (JSON.stringify(next) === before) return false;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Keep the last good generation as .bak. If the live file is corrupt,
    // readAuthFile above used the old .bak; copying the corrupt file over
    // that backup would destroy the only readable copy.
    const live = await readFile(file, "utf8").catch(() => null);
    let liveParses = false;
    if (live !== null) {
      try {
        parseAuth(live);
        liveParses = true;
      } catch {}
    }
    if (liveParses) await copyFile(file, `${file}.bak`).catch(() => {});
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
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
    await rm(temp, { force: true }).catch(() => {});
    return true;
  } finally {
    await unlock();
  }
}
