import assert from "node:assert/strict";
import test from "node:test";
import { parseGithubURL } from "../lib/config.mjs";

test("parses Magpie's github:// sync address", () => {
  assert.deepEqual(parseGithubURL("github://NotoChen/magpie-sync"), { repo: "NotoChen/magpie-sync", prefix: "" });
  assert.deepEqual(parseGithubURL("github://owner/repo/magpie"), { repo: "owner/repo", prefix: "magpie" });
});

test("refuses addresses Magpie sync would not accept", () => {
  for (const value of ["https://github.com/a/b", "github://a", "github://a/b/../c", "github://a/b?x=1"]) {
    assert.throws(() => parseGithubURL(value));
  }
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";

test("role follows sync.json.followServer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-sync-config-"));
  await writeFile(join(dir, "sync.json"), JSON.stringify({
    url: "github://owner/repo",
    password: "token",
    passphrase: "pass",
    followServer: true,
  }), "utf8");
  assert.equal(loadConfig(dir).role, "slave");
  await writeFile(join(dir, "workbuddy-sync.json"), JSON.stringify({ role: "master" }), "utf8");
  assert.equal(loadConfig(dir).role, "master");
  assert.equal(loadConfig(dir).roleSource, "workbuddy-sync.json");
});
