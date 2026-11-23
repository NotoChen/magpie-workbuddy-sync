// Followers check in through separate small files beside the snapshot:
//
//   workbuddy/followers/<machineId>.json
//
// A follower only writes its own file, so there is no shared-file race. The
// master lists the folder and counts recent `role: "slave"` entries. The
// files hold no token; they are just presence and a display name.
import { hostname } from "node:os";

export function presenceDir(config) {
  const slash = config.path.lastIndexOf("/");
  return slash >= 0 ? `${config.path.slice(0, slash)}/followers` : "followers";
}

export function presenceFile(config, machineId) {
  return `${presenceDir(config)}/${encodeURIComponent(machineId)}.json`;
}

export function namesFile(config) {
  return `${presenceDir(config)}/names.json`;
}

export async function readNames(store, config) {
  const file = namesFile(config);
  const current = await store.read(file);
  if (!current) return {};
  try {
    const payload = JSON.parse(current.data.toString("utf8"));
    return payload && typeof payload.names === "object" && !Array.isArray(payload.names)
      ? payload.names
      : {};
  } catch {
    return {};
  }
}

export async function writeNames(store, config, names) {
  const file = namesFile(config);
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    names,
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  let current = await store.read(file).catch(() => null);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (typeof store.writeIf === "function") {
        await store.writeIf(file, bytes, "workbuddy-sync: follower names", current?.sha || null);
      } else {
        await store.write(file, bytes, "workbuddy-sync: follower names");
      }
      return true;
    } catch (e) {
      if (!e?.conflict || attempt === 2) throw e;
      current = await store.read(file).catch(() => null);
    }
  }
  return false;
}

export async function checkIn(store, config, state) {
  if (!state?.machineId || config.role !== "slave") return false;
  const every = config.presenceMinutes * 60_000;
  const last = Date.parse(state.lastPresenceAt || "") || 0;
  const names = await readNames(store, config).catch(() => ({}));
  const alias = names[state.machineId] || config.name || hostname();
  // A name changed by the master should become visible on the next poll,
  // not only after the normal heartbeat interval. The heartbeat is still
  // rate-limited when the name is unchanged.
  if (last && Date.now() - last < every && state.presenceAlias === alias) return false;
  const file = presenceFile(config, state.machineId);
  const body = {
    version: 1,
    machineId: state.machineId,
    alias,
    role: "slave",
    appliedGeneration: Number(state.generation) || 0,
    appliedAt: state.lastPullAt || "",
    accountCount: Number(state.accountCount) || 0,
    lastSeen: new Date().toISOString(),
  };
  let current = await store.read(file).catch(() => null);
  const write = async () => {
    const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
    if (typeof store.writeIf === "function") return store.writeIf(file, bytes, "workbuddy-sync: follower presence", current?.sha || null);
    return store.write(file, bytes, "workbuddy-sync: follower presence");
  };
  try {
    await write();
  } catch (e) {
    if (!e?.conflict) throw e;
    current = await store.read(file).catch(() => null);
    await write();
  }
  state.lastPresenceAt = body.lastSeen;
  state.presenceAlias = body.alias;
  return true;
}

export async function listFollowers(store, config, now = Date.now(), excludeMachineId = "") {
  const names = await readNames(store, config).catch(() => ({}));
  const entries = await store.list(presenceDir(config)).catch((e) => {
    if (String(e?.message || "").includes("404")) return [];
    throw e;
  });
  const stale = config.presenceStaleMinutes * 60_000;
  const out = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    let payload;
    try {
      const file = await store.read(entry.path);
      if (!file) continue;
      payload = JSON.parse(file.data.toString("utf8"));
    } catch {
      continue;
    }
    if (payload?.role !== "slave" || !payload.machineId) continue;
    if (excludeMachineId && payload.machineId === excludeMachineId) continue;
    const seen = Date.parse(payload.lastSeen || "");
    if (!Number.isFinite(seen)) continue;
    out.push({
      machineId: String(payload.machineId),
      alias: String(names[payload.machineId] || payload.alias || ""),
      lastSeen: payload.lastSeen,
      appliedGeneration: Number(payload.appliedGeneration) || 0,
      appliedAt: payload.appliedAt || "",
      accountCount: Number(payload.accountCount) || 0,
      online: now - seen <= stale,
    });
  }
  out.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return out;
}
