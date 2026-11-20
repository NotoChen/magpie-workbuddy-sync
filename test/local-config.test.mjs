import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPageCommand } from "../lib/local-config.mjs";

test("page role commands change only their own machine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-sync-local-"));
  await writeFile(join(dir, "workbuddy-sync.json"), JSON.stringify({ pollSeconds: 20 }), "utf8");
  assert.equal(await applyPageCommand(dir, { action: "set-role", machine: "other", role: "slave" }, "mine"), false);
  assert.equal(await applyPageCommand(dir, { action: "set-role", machine: "mine", role: "slave" }, "mine"), true);
  let saved = JSON.parse(await readFile(join(dir, "workbuddy-sync.json"), "utf8"));
  assert.equal(saved.role, "slave");
  assert.equal(saved.pollSeconds, 20);
  assert.equal(await applyPageCommand(dir, { action: "set-role", machine: "mine", role: "auto" }, "mine"), true);
  saved = JSON.parse(await readFile(join(dir, "workbuddy-sync.json"), "utf8"));
  assert.equal(saved.role, undefined);
});
