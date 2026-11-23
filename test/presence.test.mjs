import assert from "node:assert/strict";
import test from "node:test";
import { checkIn, listFollowers, presenceDir, presenceFile } from "../lib/presence.mjs";

function config(overrides = {}) {
  return {
    role: "slave",
    path: "workbuddy/workbuddy-auth.magpie-data",
    name: "书房 Mac",
    presenceMinutes: 60,
    presenceStaleMinutes: 180,
    ...overrides,
  };
}

function store() {
  const files = new Map();
  return {
    files,
    async read(path) {
      const entry = files.get(path);
      return entry ? { data: Buffer.from(entry), sha: `sha-${path}` } : null;
    },
    async list(path) {
      const prefix = `${path}/`;
      return [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ name: key.slice(prefix.length), path: key }));
    },
    async writeIf(path, bytes) {
      files.set(path, Buffer.from(bytes).toString("utf8"));
      return { sha: `sha-${path}` };
    },
  };
}

test("a follower checks in, and the master lists it", async () => {
  const s = store();
  const c = config();
  const state = { machineId: "machine-a", lastPresenceAt: "" };
  assert.equal(await checkIn(s, c, state), true);
  assert.ok(s.files.has(presenceFile(c, "machine-a")));
  const followers = await listFollowers(s, c);
  assert.equal(followers.length, 1);
  assert.equal(followers[0].alias, "书房 Mac");
  assert.equal(followers[0].machineId, "machine-a");
  assert.equal(presenceDir(c), "workbuddy/followers");
});

test("stale follower check-ins are not counted", async () => {
  const s = store();
  const c = config({ presenceStaleMinutes: 10 });
  await s.writeIf(presenceFile(c, "old"), Buffer.from(JSON.stringify({
    version: 1,
    machineId: "old",
    alias: "旧机器",
    role: "slave",
    lastSeen: "2020-01-01T00:00:00.000Z",
  })));
  const followers = await listFollowers(s, c);
  assert.equal(followers.length, 1);
  assert.equal(followers[0].online, false);
});
