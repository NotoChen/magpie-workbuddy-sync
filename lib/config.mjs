import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Read a JSON file, returning undefined when it is not there or does not parse.
export function readJSON(file) {
  try {
    const text = readFileSync(file, "utf8");
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

// parseGithubURL accepts the github://owner/repo[/folder] form Magpie's own
// GitHub sync uses. It returns the repository and the optional folder.
export function parseGithubURL(raw) {
  const rawText = String(raw || "").trim();
  // URL() collapses dot segments; Magpie sync refuses them, so reject the
  // spelling before the parser can turn it into another path.
  if (/\/\.\.?(?:\/|$)/.test(rawText)) throw new Error("the GitHub folder in sync.json is not valid");
  let u;
  try {
    u = new URL(rawText);
  } catch {
    throw new Error("sync.json does not hold a github:// URL");
  }
  if (u.protocol !== "github:" || !u.host || u.username || u.password || u.port || u.search || u.hash) {
    throw new Error("only Magpie's github:// sync address is supported");
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (!u.host || parts.length < 1) throw new Error("sync.json needs github://owner/repo");
  const bad = (s) => !s || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s);
  if (bad(u.host) || bad(parts[0])) throw new Error("sync.json needs github://owner/repo");
  for (const p of parts.slice(1)) {
    if (p === "." || p === ".." || /[\\\x00\r\n]/.test(p)) throw new Error("the GitHub folder in sync.json is not valid");
  }
  return {
    repo: `${u.host}/${parts[0]}`,
    prefix: parts.slice(1).join("/"),
  };
}

// loadConfig reads the existing Magpie sync setup. A follower is a slave
// without asking; every other computer is *unconfigured* until a local
// workbuddy-sync.json names it master or slave. A non-following computer is
// never promoted to master by accident: two Magpie computers syncing both ways
// would otherwise both publish a competing snapshot.
//
// A local workbuddy-sync.json can set the role and a few transport details.
// It is local on purpose: plugins.json is carried by Magpie sync, so a role
// kept there would be copied to every follower.
export function loadConfig(dir) {
  const sync = readJSON(join(dir, "sync.json")) || {};
  const local = readJSON(join(dir, "workbuddy-sync.json")) || {};
  const settings = readJSON(join(dir, "settings.json")) || {};

  let github;
  let error = "";
  try {
    github = parseGithubURL(sync.url);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    github = null;
  }

  // A non-following computer is not automatically a master. Only an
  // explicit role in workbuddy-sync.json makes one; this keeps a second
  // machine that happens to sync both ways from publishing a competing
  // snapshot. A following computer is a slave without asking.
  let role = "unconfigured";
  let roleSource = "unset";
  if (local.role === "master" || local.role === "slave") {
    role = local.role;
    roleSource = "workbuddy-sync.json";
  } else if (sync.followServer === true) {
    role = "slave";
    roleSource = "sync.json.followServer";
  }
  const token = String(local.token ?? sync.password ?? settings.githubToken ?? "").trim();
  const passphrase = String(sync.passphrase ?? "");
  const path = String(local.path || [github?.prefix, "workbuddy", "workbuddy-auth.magpie-data"].filter(Boolean).join("/")).replace(/^\/+/, "");
  const branch = String(local.branch ?? sync.branch ?? "").trim();
  const pollSeconds = clampInt(local.pollSeconds, 10, 3600, role === "slave" ? 30 : 15);
  const allowEmpty = local.allowEmpty === true;
  const allowMasterChange = local.allowMasterChange === true;
  const leaseHours = clampInt(local.leaseHours, 1, 24 * 30, 24);
  const name = String(local.name || "").trim().slice(0, 80);
  const presenceMinutes = clampInt(local.presenceMinutes, 5, 1440, 60);
  const presenceStaleMinutes = clampInt(local.presenceStaleMinutes, 10, 10080, 180);
  const followerNames = readNameMap(local.followerNames);
  const includeAccounts = Array.isArray(local.includeAccounts)
    ? local.includeAccounts.filter((key) => typeof key === "string")
    : null;

  if (!error && !token) error = "sync.json has no GitHub token for its github:// address";
  if (!error && !passphrase) error = "sync.json has no passphrase; Magpie's GitHub sync needs one first";

  return {
    dir,
    role,
    roleSource,
    followServer: sync.followServer === true,
    github,
    token,
    passphrase,
    path,
    branch,
    pollSeconds,
    allowEmpty,
    allowMasterChange,
    leaseHours,
    name,
    presenceMinutes,
    presenceStaleMinutes,
    followerNames,
    includeAccounts,
    syncURL: String(sync.url || ""),
    syncFile: join(dir, "sync.json"),
    localFile: join(dir, "workbuddy-sync.json"),
    stateFile: join(dir, "workbuddy-sync-state.json"),
    authFile: join(dir, "plugin-auth.json"),
    error,
  };
}

function readNameMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [machineId, name] of Object.entries(value)) {
    if (typeof name !== "string") continue;
    out[String(machineId).slice(0, 128)] = name.trim().slice(0, 80);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
