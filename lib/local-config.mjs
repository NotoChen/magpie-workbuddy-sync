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
  if (command.action !== "set-role") return false;
  const role = command.role;
  if (role !== "auto" && role !== "master" && role !== "slave") return false;
  const file = join(dir, "workbuddy-sync.json");
  const current = await readJSON(file);
  const next = { ...current };
  if (role === "auto") delete next.role;
  else next.role = role;
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file).catch(async () => {
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  });
  return true;
}

export function commandFor(machineId, role) {
  return { action: "set-role", machine: machineId, role, at: Date.now() };
}
