import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubStore } from "../lib/github.mjs";

test("GitHub contents store reads metadata and creates a file", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).endsWith("/repos/owner/repo")) {
      return new Response(JSON.stringify({ private: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/contents/") && (init.method || "GET") === "GET") {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/contents/") && init.method === "PUT") {
      return new Response(JSON.stringify({ content: { sha: "new-sha" } }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  };
  try {
    const store = await createGitHubStore({
      github: { repo: "owner/repo", prefix: "" },
      token: "token",
      branch: "",
      syncURL: "github://owner/repo",
    });
    const result = await store.write("workbuddy/workbuddy-auth.magpie-data", Buffer.from("sealed"), "test");
    assert.equal(result.sha, "new-sha");
    assert.ok(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/workbuddy/workbuddy-auth.magpie-data")));
  } finally {
    globalThis.fetch = original;
  }
});
