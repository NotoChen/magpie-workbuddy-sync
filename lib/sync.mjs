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
    this.state = await loadState(loadConfig(this.dir).stateFile);
    if (await this.tryStart()) return;
    // Magpie starts more than one plugin host (the window's, a page's, a
    // CLI's). Only the lock owner writes the status page; a losing host
    // waits without replacing the owner's status with a misleading error.
    this.waitTimer = setInterval(() => {
      void this.tryStart();
    }, 10_000);
  }

  async tryStart() {
    if (this.releaseLock) return true;
    const config = loadConfig(this.dir);
    const release = await acquireEngineLock(this.dir);
    if (!release) return false;
    this.releaseLock = release;
    if (this.waitTimer) {
      clearInterval(this.waitTimer);
      this.waitTimer = null;
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
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
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
      leaseOwner: this.state.leaseOwner || "",
      leaseEpoch: this.state.leaseEpoch || 0,
      leaseExpiresAt: this.state.leaseExpiresAt || 0,
      lastPushAt: this.state.lastPushAt || "",
      lastPullAt: this.state.lastPullAt || "",
      lastRemoteSha: this.state.lastRemoteSha || "",
      machineId: this.state.machineId || "",
      ok: true,
      message: "",
      error: "",
      warning: "",
      securityWarning: config.passphrase && config.passphrase.length < 12 ? "sync.json 的同步口令较短；建议在 workbuddy-sync.json 中为 WorkBuddy 快照设置更长口令。" : "",
    };
    if (config.error) {
      return { ...base, ok: false, message: "config incomplete", error: config.error };
    }
    if (config.role === "unconfigured") {
      return {
        ...base,
        ok: false,
        message: "role not selected",
        warning: "非跟随机器默认不参与同步；请在页面选择主机或从机。",
      };
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
    const masterId = this.state.masterId || randomUUID();
    const leaseMs = config.leaseHours * 3600_000;
    let lastConflict;
    for (let attempt = 0; attempt < 5; attempt++) {
      const remote = await this.store.read(config.path);
      let prior = null;
      if (remote) {
        prior = await openData(remote.data, config.passphrase);
        if (!prior || prior.version !== SNAPSHOT_VERSION || !prior.accounts || typeof prior.accounts !== "object") {
          throw new Error("the WorkBuddy snapshot has an unsupported shape");
        }
      }
      const priorOwner = String(prior?.lease?.owner || prior?.masterId || "");
      const priorEpoch = Number(prior?.lease?.epoch || 0);
      const priorExpires = Number(prior?.lease?.expiresAt || 0);
      const now = Date.now();
      let epoch = Math.max(Number(this.state.leaseEpoch || 0), priorEpoch, 1);
      let expiresAt = Number(this.state.leaseExpiresAt || 0);
      if (priorOwner && priorOwner !== masterId) {
        if (!config.allowMasterChange) {
          return {
            ...base,
            ok: false,
            message: "another master owns the snapshot",
            warning: "另一台主机已经持有这份 WorkBuddy 快照的租约；请把本机设为从机，或在新主机上设置 allowMasterChange 执行一次明确的主机接管。",
          };
        }
        // An explicit takeover replaces the lease even while it is alive.
        // The next write of the old master sees this new owner and stops.
        epoch = Math.max(priorEpoch + 1, 1);
        expiresAt = now + leaseMs;
      } else if (!prior || !priorOwner) {
        // First lease, or a snapshot made before leases existed.
        epoch = Math.max(priorEpoch + 1, epoch, 1);
        expiresAt = now + leaseMs;
      } else {
        expiresAt = Math.max(expiresAt, now + leaseMs);
      }
      if (hash === this.state.lastPublishedHash && remote && priorOwner === masterId && priorExpires - now > leaseMs / 2) {
        return { ...base, message: "master is current", leaseOwner: masterId, leaseEpoch: epoch, leaseExpiresAt: priorExpires };
      }
      const generation = Math.max(Number(prior?.generation || 0), Number(this.state.generation || 0)) + 1;
      const payload = {
        version: SNAPSHOT_VERSION,
        masterId,
        generation,
        publishedAt: new Date().toISOString(),
        lease: { owner: masterId, epoch, expiresAt: Math.max(expiresAt, now + leaseMs) },
        accounts,
      };
      const sealed = await sealData(payload, config.passphrase);
      try {
        const written = await this.store.writeIf(
          config.path,
          sealed,
          `workbuddy-sync: ${count} account${count === 1 ? "" : "s"} (generation ${generation}, lease ${epoch})`,
          remote?.sha || null,
        );
        this.state = {
          ...this.state,
          masterId,
          leaseEpoch: epoch,
          leaseExpiresAt: payload.lease.expiresAt,
          generation,
          lastPublishedHash: hash,
          lastRemoteSha: written.sha || "",
          lastPushAt: new Date().toISOString(),
        };
        await saveState(config.stateFile, this.state);
        this.log(`[workbuddy-sync] published ${count} WorkBuddy accounts (generation ${generation}, lease ${epoch})`);
        return {
          ...base,
          masterId,
          leaseOwner: masterId,
          leaseEpoch: epoch,
          leaseExpiresAt: payload.lease.expiresAt,
          generation,
          accountCount: count,
          lastRemoteSha: written.sha || "",
          lastPushAt: this.state.lastPushAt,
          message: `published ${count} account${count === 1 ? "" : "s"}`,
        };
      } catch (e) {
        if (!e?.conflict) throw e;
        lastConflict = e;
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    throw lastConflict || new Error("the WorkBuddy snapshot kept changing while publishing");
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
    const remoteGeneration = Number(payload.generation || 0);
    const remoteEpoch = Number(payload.lease?.epoch || 0);
    if ((this.state.generation && remoteGeneration && remoteGeneration < this.state.generation)
      || (this.state.leaseEpoch && remoteEpoch && remoteEpoch < this.state.leaseEpoch)) {
      return {
        ...base,
        ok: false,
        message: "stale snapshot ignored",
        warning: "GitHub 上的快照比本机已应用的一代更旧；已保留本机状态，等待主机的下一次发布。",
      };
    }
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
      leaseOwner: payload.lease?.owner || payload.masterId || this.state.leaseOwner || "",
      leaseEpoch: payload.lease?.epoch || this.state.leaseEpoch || 0,
      leaseExpiresAt: payload.lease?.expiresAt || this.state.leaseExpiresAt || 0,
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
