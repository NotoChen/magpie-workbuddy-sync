import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncEngine } from "../lib/sync.mjs";

async function home(followServer) {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-sync-home-"));
  await writeFile(join(dir, "sync.json"), JSON.stringify({
    url: "github://owner/private-repo",
    password: "github-token",
    passphrase: "sync-passphrase",
    followServer,
  }), "utf8");
  return dir;
}

function fakeStore() {
  return {
    data: null,
    sha: "",
    writes: 0,
    async read() {
      return this.data ? { data: Buffer.from(this.data), sha: this.sha } : null;
    },
    async write(_file, bytes) {
      this.data = Buffer.from(bytes);
      this.writes += 1;
      this.sha = `sha-${this.data.length}-${Date.now()}`;
      return { sha: this.sha };
    },
  };
}

test("master publishes, follower applies access-only accounts", async () => {
  const master = await home(false);
  const slave = await home(true);
  await writeFile(join(master, "plugin-auth.json"), JSON.stringify({
    workbuddy: { type: "oauth", access: "a1", refresh: "r1", uid: "u1", accountId: "一号", expires: 111 },
    "workbuddy#b": { type: "oauth", access: "a2", refresh: "r2", uid: "u2", accountId: "二号", expires: 222 },
    "workbuddy-ai": { type: "oauth", access: "a3", refresh: "r3", uid: "u3", accountId: "Intl", expires: 333 },
    other: { type: "api", key: "keep" },
  }), "utf8");
  await writeFile(join(slave, "plugin-auth.json"), JSON.stringify({ other: { type: "api", key: "keep" } }), "utf8");
  const store = fakeStore();
  const pluginDir = await mkdtemp(join(tmpdir(), "workbuddy-sync-plugin-"));
  await mkdir(join(pluginDir, "page"), { recursive: true });

  const masterEngine = new SyncEngine({ dir: master, pluginDir, options: { storeFactory: () => store }, log: () => {} });
  const published = await masterEngine.runOnce();
  assert.equal(published.ok, true);
  assert.equal(published.accountCount, 3);
  const second = await masterEngine.runOnce();
  assert.equal(second.ok, true);
  assert.equal(store.writes, 1, "an unchanged master does not upload again");

  const slaveEngine = new SyncEngine({ dir: slave, pluginDir, options: { storeFactory: () => store }, log: () => {} });
  const applied = await slaveEngine.runOnce();
  assert.equal(applied.ok, true);
  assert.equal(applied.accountCount, 3);
  const saved = JSON.parse(await readFile(join(slave, "plugin-auth.json"), "utf8"));
  assert.equal(saved.other.key, "keep");
  assert.deepEqual(Object.keys(saved), ["other", "workbuddy", "workbuddy#b", "workbuddy-ai"]);
  for (const key of ["workbuddy", "workbuddy#b", "workbuddy-ai"]) {
    assert.equal(saved[key].access, key === "workbuddy" ? "a1" : key === "workbuddy#b" ? "a2" : "a3");
    assert.equal(saved[key].refresh, undefined);
    assert.equal(saved[key].expires, 0);
  }
});

test("follower strips a refresh token written after the first sync", async () => {
  const slave = await home(true);
  await writeFile(join(slave, "plugin-auth.json"), JSON.stringify({
    workbuddy: { type: "oauth", access: "a", refresh: "late-refresh", uid: "u", expires: 999 },
  }), "utf8");
  const pluginDir = await mkdtemp(join(tmpdir(), "workbuddy-sync-plugin-"));
  await mkdir(join(pluginDir, "page"), { recursive: true });
  const engine = new SyncEngine({ dir: slave, pluginDir, options: { storeFactory: () => ({ async read() { return null; } }) }, log: () => {} });
  await engine.runOnce();
  const saved = JSON.parse(await readFile(join(slave, "plugin-auth.json"), "utf8"));
  assert.equal(saved.workbuddy.refresh, undefined);
  assert.equal(saved.workbuddy.expires, 0);
  assert.equal(saved.workbuddy.access, "a");
});
