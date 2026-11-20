import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";
import {
  collectWorkBuddy,
  countWorkBuddy,
  enforceSlave,
  fingerprint,
  mergeForSlave,
  readAuthFile,
  writeAuthFile,
} from "./auth-store.mjs";
import { openData, sealData } from "./crypto.mjs";
import { createGitHubStore } from "./github.mjs";
import { acquireEngineLock } from "./engine-lock.mjs";
import { clearWorkBuddyLapse } from "./logins-store.mjs";
import { applyPageCommand } from "./local-config.mjs";
import { writePageStatus } from "./status.mjs";

const SNAPSHOT_VERSION = 1;

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function loadState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function saveState(file, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file).catch(async () => {
    await writeFile(file, text, { mode: 0o600 });
  });
}

function storeKey(config) {
  return createHash("sha256").update(`${config.github?.repo || ""}\0${config.token}\0${config.branch}`).digest("hex");
}

export class SyncEngine {
  constructor({ dir, pluginDir, options = {}, log = console.log }) {
    this.dir = dir;
    this.pluginDir = pluginDir;
    this.options = options;
    this.log = log;
    this.storeFactory = options.storeFactory || createGitHubStore;
    this.timer = null;
    this.busy = false;
    this.state = {};
    this.store = null;
    this.storeId = "";
    this.status = {
      role: "unknown",
      ok: false,
      message: "starting",
    };
  }

  async start() {
    const config = loadConfig(this.dir);
    this.releaseLock = await acquireEngineLock(this.dir);
    if (!this.releaseLock) {
      this.status = { role: config.role, ok: false, message: "another Magpie process is running WorkBuddy Sync", error: "this process only reads the status; the other one keeps the lock" };
      await writePageStatus(this.pluginDir, this.status).catch(() => {});
      return;
    }
    this.state = await loadState(config.stateFile);
    if (!this.state.machineId) {
      this.state.machineId = randomUUID();
      await saveState(config.stateFile, this.state);
    }
    // A page command is applied once. The command stays in plugins.json
    // (Magpie gives a plugin no setter for its own options here), so its
    // timestamp is remembered: editing workbuddy-sync.json by hand later
    // must not be undone by the old command on every host restart.
    const pageCommand = this.options?.workbuddySyncCommand;
    const commandAt = Number(pageCommand?.at) || 0;
    if (commandAt > Number(this.state.lastCommandAt || 0)) {
      const applied = await applyPageCommand(this.dir, pageCommand, this.state.machineId).catch(() => false);
      if (applied) {
        this.state.lastCommandAt = commandAt;
        await saveState(config.stateFile, this.state);
      }
    }
    await this.tick();
    const every = Math.max(10, Math.min(3600, Number(loadConfig(this.dir).pollSeconds) || 30));
    this.timer = setInterval(() => {
      void this.tick();
    }, every * 1000);
    // Keep the host alive: a plugin whose function returns must keep its
    // timer running; this timer is the plugin's work, not a UI detail.
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseLock?.().catch(() => {});
    this.releaseLock = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    let status;
    try {
      status = await this.runOnce();
    } catch (error) {
      status = {
        ...this.status,
        ok: false,
        message: "sync failed",
        error: safeError(error),
      };
    } finally {
      this.busy = false;
    }
    this.status = status;
    await writePageStatus(this.pluginDir, status).catch((error) => this.log(`[workbuddy-sync] status: ${safeError(error)}`));
  }

  async runOnce() {
    const config = loadConfig(this.dir);
    const base = {
      role: config.role,
      roleSource: config.roleSource,
      followServer: config.followServer,
      repo: config.github?.repo || "",
      path: config.path,
      branch: config.branch,
      accountCount: 0,
      generation: this.state.generation || 0,
      masterId: this.state.masterId || "",
      lastPushAt: this.state.lastPushAt || "",
      lastPullAt: this.state.lastPullAt || "",
      lastRemoteSha: this.state.lastRemoteSha || "",
      machineId: this.state.machineId || "",
      ok: true,
      message: "",
      error: "",
      warning: "",
      securityWarning: config.passphrase && config.passphrase.length < 12 ? "sync.json passphrase is short; consider a longer one for the WorkBuddy snapshot" : "",
    };
    if (config.error) {
      return { ...base, ok: false, message: "config incomplete", error: config.error };
    }
    const pass = createHash("sha256").update(config.passphrase || "").digest("hex").slice(0, 8);
    const target = `${config.github?.repo || ""}/${config.path}@${config.branch}#${pass}`;
    if (this.state.target !== target) this.state = { target };
    await this.ensureStore(config);
    if (config.role === "master") return this.publish(config, base);
    return this.follow(config, base);
  }

  async ensureStore(config) {
    const id = storeKey(config);
    if (this.store && this.storeId === id) return;
    this.store = await this.storeFactory(config);
    this.storeId = id;
  }

  async publish(config, base) {
    const auth = await readAuthFile(config.authFile);
    const accounts = collectWorkBuddy(auth);
    const count = Object.keys(accounts).length;
    base.accountCount = count;
    if (count === 0 && !config.allowEmpty) {
      return {
        ...base,
        ok: false,
        message: "master has no WorkBuddy accounts",
        warning: "nothing published; sign in on this computer first, or set allowEmpty in workbuddy-sync.json",
      };
    }
    const hash = fingerprint(accounts);
    if (hash === this.state.lastPublishedHash && this.state.lastRemoteSha) {
      return { ...base, message: "master is current" };
    }
    const generation = Number(this.state.generation || 0) + 1;
    const masterId = this.state.masterId || randomUUID();
    const payload = {
      version: SNAPSHOT_VERSION,
      masterId,
      generation,
      publishedAt: new Date().toISOString(),
      accounts,
    };
    const sealed = await sealData(payload, config.passphrase);
    const written = await this.store.write(
      config.path,
      sealed,
      `workbuddy-sync: ${count} account${count === 1 ? "" : "s"} (generation ${generation})`,
    );
    this.state = {
      ...this.state,
      masterId,
      generation,
      lastPublishedHash: hash,
      lastRemoteSha: written.sha || "",
      lastPushAt: new Date().toISOString(),
    };
    await saveState(config.stateFile, this.state);
    this.log(`[workbuddy-sync] published ${count} WorkBuddy accounts (generation ${generation})`);
    return {
      ...base,
      masterId,
      generation,
      accountCount: count,
      lastRemoteSha: written.sha || "",
      lastPushAt: this.state.lastPushAt,
      message: `published ${count} account${count === 1 ? "" : "s"}`,
    };
  }

  async follow(config, base) {
    const remote = await this.store.read(config.path);
    if (!remote) {
      const cleaned = await this.cleanLocal(config);
      return {
        ...base,
        ...cleaned,
        ok: false,
        message: "master snapshot not found",
        warning: "waiting for the master to publish; local WorkBuddy accounts stay as they are",
      };
    }
    if (remote.sha && remote.sha === this.state.lastRemoteSha) {
      const cleaned = await this.cleanLocal(config);
      return { ...base, ...cleaned, message: "follower is current" };
    }
    const payload = await openData(remote.data, config.passphrase);
    if (!payload || payload.version !== SNAPSHOT_VERSION || !payload.accounts || typeof payload.accounts !== "object") {
      throw new Error("the WorkBuddy snapshot has an unsupported shape");
    }
    const remoteCount = Object.keys(payload.accounts).length;
    if (remoteCount === 0 && !config.allowEmpty) {
      const cleaned = await this.cleanLocal(config);
      return {
        ...base,
        ...cleaned,
        ok: false,
        message: "master snapshot is empty",
        warning: "nothing applied; the master may have no WorkBuddy account",
      };
    }
    let changed = false;
    await writeAuthFile(config.authFile, (current) => {
      const next = mergeForSlave(current, payload.accounts);
      changed = JSON.stringify(next) !== JSON.stringify(current);
      return next;
    });
    const cleaned = await this.cleanLocal(config);
    // A fresh snapshot is the moment a stale lapsed mark should stop
    // keeping the account out of routing.
    await clearWorkBuddyLapse(join(config.dir, "logins.json"), Object.keys(payload.accounts)).catch(() => {});
    this.state = {
      ...this.state,
      masterId: payload.masterId || this.state.masterId || "",
      generation: payload.generation || this.state.generation || 0,
      lastRemoteSha: remote.sha || "",
      lastPullAt: new Date().toISOString(),
    };
    await saveState(config.stateFile, this.state);
    this.log(`[workbuddy-sync] applied ${remoteCount} WorkBuddy accounts (generation ${payload.generation || 0})`);
    return {
      ...base,
      ...cleaned,
      masterId: this.state.masterId,
      generation: this.state.generation,
      accountCount: remoteCount,
      lastRemoteSha: remote.sha || "",
      lastPullAt: this.state.lastPullAt,
      message: changed ? `applied ${remoteCount} account${remoteCount === 1 ? "" : "s"}` : "follower is current",
    };
  }

  async cleanLocal(config) {
    const auth = await readAuthFile(config.authFile);
    const cleaned = enforceSlave(auth);
    const changed = JSON.stringify(cleaned) !== JSON.stringify(auth);
    if (changed) await writeAuthFile(config.authFile, () => cleaned);
    return { accountCount: countWorkBuddy(cleaned), cleaned: changed };
  }
}
