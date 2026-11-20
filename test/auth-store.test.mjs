import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectWorkBuddy,
  countWorkBuddy,
  enforceSlave,
  mergeForSlave,
  readAuthFile,
  writeAuthFile,
} from "../lib/auth-store.mjs";

const master = {
  workbuddy: { type: "oauth", access: "a1", refresh: "r1", uid: "u1", accountId: "账号一", domain: "x", expires: 123 },
  "workbuddy#b": { type: "oauth", access: "a2", refresh: "r2", uid: "u2", accountId: "账号二", expires: 456 },
  "workbuddy-ai": { type: "oauth", access: "a3", refresh: "r3", uid: "u3", accountId: "Intl", expires: 789 },
  other: { type: "api", key: "keep-me" },
};

test("collects all WorkBuddy accounts and skips desktop markers", () => {
  const got = collectWorkBuddy({
    ...master,
    "workbuddy#desktop": { type: "oauth", source: "desktop", uid: "u4" },
  });
  assert.equal(Object.keys(got).length, 3);
  assert.equal(countWorkBuddy(got), 3);
  assert.ok(got.workbuddy.refresh);
});

test("followers get access-only entries with matching keys", () => {
  const got = mergeForSlave({ other: { type: "api", key: "keep-me" } }, master);
  assert.deepEqual(Object.keys(got), ["other", "workbuddy", "workbuddy#b", "workbuddy-ai"]);
  assert.equal(got.workbuddy.access, "a1");
  assert.equal(got.workbuddy.refresh, undefined);
  assert.equal(got.workbuddy.refreshExpiresAt, undefined);
  assert.equal(got.workbuddy.expires, 0);
  assert.equal(got["workbuddy#b"].accountId, "账号二");
  assert.equal(got["workbuddy-ai"].uid, "u3");
});

test("enforceSlave strips anything that could refresh", () => {
  const got = enforceSlave({
    ...master,
    "workbuddy#desktop": { type: "oauth", source: "desktop", uid: "u4" },
  });
  assert.equal(got.workbuddy.refresh, undefined);
  assert.equal(got.workbuddy.expires, 0);
  assert.equal(got["workbuddy#desktop"], undefined);
  assert.equal(got.other.key, "keep-me");
});

test("writeAuthFile keeps other providers and writes a backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-sync-"));
  const file = join(dir, "plugin-auth.json");
  await writeFile(file, JSON.stringify({ other: { type: "api", key: "x" } }), "utf8");
  const changed = await writeAuthFile(file, (current) => mergeForSlave(current, master));
  assert.equal(changed, true);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.other.key, "x");
  assert.equal(saved.workbuddy.access, "a1");
  assert.equal(saved.workbuddy.refresh, undefined);
  const backup = JSON.parse(await readFile(`${file}.bak`, "utf8"));
  assert.equal(backup.other.key, "x");
  assert.equal(backup.workbuddy, undefined);
  assert.equal((await readAuthFile(file)).workbuddy.access, "a1");
});

import { clearWorkBuddyLapse } from "../lib/logins-store.mjs";

test("clears stale lapsed marks for the applied WorkBuddy accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-sync-logins-"));
  const file = join(dir, "logins.json");
  await writeFile(file, JSON.stringify([
    { agent: "plugin:workbuddy", home: "workbuddy", lapsed: "expired", refused: "x" },
    { agent: "plugin:workbuddy-ai", home: "workbuddy-ai", lapsed: "expired" },
    { agent: "plugin:other", home: "other", lapsed: "keep" },
  ]), "utf8");
  assert.equal(await clearWorkBuddyLapse(file, ["workbuddy"]), true);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved[0].lapsed, undefined);
  assert.equal(saved[0].refused, undefined);
  assert.equal(saved[1].lapsed, "expired");
  assert.equal(saved[2].lapsed, "keep");
});
