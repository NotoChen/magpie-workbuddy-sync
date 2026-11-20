import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncEngine } from "../lib/sync.mjs";

test("a lock-losing host does not overwrite the owner's status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-sync-lock-"));
  const pluginDir = await mkdtemp(join(tmpdir(), "workbuddy-sync-page-"));
  await mkdir(join(pluginDir, "page"), { recursive: true });
  await writeFile(join(dir, "sync.json"), JSON.stringify({
    url: "github://owner/repo",
    password: "token",
    passphrase: "pass",
  }), "utf8");
  const store = {
    async read() { return null; },
    async write() { return { sha: "x" }; },
  };
  const one = new SyncEngine({ dir, pluginDir, options: { storeFactory: () => store }, log: () => {} });
  const two = new SyncEngine({ dir, pluginDir, options: { storeFactory: () => store }, log: () => {} });
  await one.start();
  const before = await readFile(join(pluginDir, "page", "data.js"), "utf8");
  await two.start();
  const after = await readFile(join(pluginDir, "page", "data.js"), "utf8");
  assert.equal(after, before);
  one.stop();
  two.stop();
});
