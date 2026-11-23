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

export async function checkIn(store, config, state) {
  if (!state?.machineId || config.role !== "slave") return false;
  const every = config.presenceMinutes * 60_000;
  const last = Date.parse(state.lastPresenceAt || "") || 0;
  if (last && Date.now() - last < every) return false;
  const file = presenceFile(config, state.machineId);
  const body = {
    version: 1,
    machineId: state.machineId,
    alias: config.name || hostname(),
    role: "slave",
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
  return true;
}

export async function listFollowers(store, config, now = Date.now(), excludeMachineId = "") {
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
      alias: String(payload.alias || ""),
      lastSeen: payload.lastSeen,
      online: now - seen <= stale,
    });
  }
  out.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return out;
}
