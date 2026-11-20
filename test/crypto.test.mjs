import assert from "node:assert/strict";
import test from "node:test";
import { openData, sealData } from "../lib/crypto.mjs";

test("seals and opens a WorkBuddy snapshot", async () => {
  const value = {
    version: 1,
    masterId: "master-a",
    generation: 7,
    accounts: {
      workbuddy: { type: "oauth", access: "access-a", refresh: "refresh-a", uid: "u1", accountId: "账号一" },
      "workbuddy#abc": { type: "oauth", access: "access-b", refresh: "refresh-b", uid: "u2" },
    },
  };
  const sealed = await sealData(value, "correct horse battery staple");
  assert.ok(Buffer.isBuffer(sealed));
  const envelope = JSON.parse(sealed.toString("utf8"));
  assert.equal(envelope.format, "magpie-data");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.kdf, "pbkdf2-sha256");
  assert.equal(envelope.iterations, 600000);
  assert.ok(Buffer.from(envelope.salt, "base64").length >= 16);
  assert.equal(Buffer.from(envelope.nonce, "base64").length, 12);
  assert.deepEqual(await openData(sealed, "correct horse battery staple"), value);
});

test("a wrong passphrase does not open the snapshot", async () => {
  const sealed = await sealData({ hello: "world" }, "passphrase-a");
  await assert.rejects(() => openData(sealed, "passphrase-b"), /wrong sync passphrase/);
});
