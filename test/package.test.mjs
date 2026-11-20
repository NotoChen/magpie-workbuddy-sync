import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package metadata is discoverable by Magpie's tagged-repository reader", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "magpie-workbuddy-sync");
  assert.ok(pkg.main);
  assert.ok(pkg.keywords.includes("magpie-page"));
  assert.ok(pkg.magpie?.page?.file);
  assert.ok(pkg.magpie?.name);
  assert.ok(pkg.magpie?.summary?.zh);
  const page = join(root, pkg.magpie.page.file);
  assert.equal((await stat(page)).isFile(), true);
});
