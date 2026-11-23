import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

// The page talks to the host through Magpie's plugin options: plugins.json
// is the only state the page can write through magpie.options.set. A
// command names this computer, so a copy of plugins.json reaching another
// computer cannot change that computer's role.
export async function applyPageCommand(dir, command, machineId) {
  if (!command || typeof command !== "object") return false;
  if (!machineId || command.machine !== machineId) return false;
  if (!["set-role", "takeover", "set-name", "set-follower-name"].includes(command.action)) return false;
  const file = join(dir, "workbuddy-sync.json");
  const current = await readJSON(file);
  const next = { ...current };
  if (command.action === "set-name") {
    if (typeof command.name !== "string") return false;
    const name = command.name.trim().slice(0, 80);
    if (name) next.name = name;
    else delete next.name;
  } else if (command.action === "set-follower-name") {
    if (typeof command.followerId !== "string" || !command.followerId) return false;
    if (typeof command.name !== "string") return false;
    next.followerNames = { ...(current.followerNames || {}), [command.followerId]: command.name.trim().slice(0, 80) };
  } else {
    const role = command.action === "takeover" ? "master" : command.role;
    if (role !== "auto" && role !== "master" && role !== "slave") return false;
    if (role === "auto") delete next.role;
    else next.role = role;
    if (command.action === "takeover") next.allowMasterChange = true;
    else delete next.allowMasterChange;
  }
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file).catch(async () => {
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  });
  return true;
}

export async function clearAllowMasterChange(dir) {
  const file = join(dir, "workbuddy-sync.json");
  const current = await readJSON(file);
  if (current.allowMasterChange !== true) return false;
  delete current.allowMasterChange;
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file).catch(async () => {
    await writeFile(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  });
  return true;
}

export function commandFor(machineId, role) {
  return { action: "set-role", machine: machineId, role, at: Date.now() };
}
