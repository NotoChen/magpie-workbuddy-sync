import { parseGithubURL } from "./config.mjs";

const API = "https://api.github.com";

function encodePath(path) {
  return String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function messageOf(body, fallback) {
  try {
    const value = JSON.parse(body);
    return value?.message ? String(value.message) : fallback;
  } catch {
    return fallback;
  }
}

// GitHubContents is a tiny Contents API client for one repository, using
// the same token and branch Magpie already uses in sync.json. It only talks
// to api.github.com: no redirect or download URL is followed.
export class GitHubContents {
  constructor({ repo, token, branch = "" }) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo || ""))) {
      throw new Error("GitHub repository must be owner/repo");
    }
    if (!token) throw new Error("GitHub token is empty");
    this.repo = repo;
    this.token = token;
    this.branch = branch;
    this._private = undefined;
  }

  async request(method, apiPath, body) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "magpie-workbuddy-sync",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API}/repos/${this.repo}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return response;
  }

  async checkPrivate() {
    if (this._private !== undefined) return this._private;
    const response = await this.request("GET", "");
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub repository check failed: HTTP ${response.status} ${messageOf(body, "")}`.trim());
    }
    const value = await response.json();
    this._private = value?.private === true;
    if (!this._private) throw new Error(`GitHub repository ${this.repo} is public; Magpie sync requires a private repository`);
    return true;
  }

  async read(file) {
    const query = this.branch ? `?ref=${encodeURIComponent(this.branch)}` : "";
    const response = await this.request("GET", `/contents/${encodePath(file)}${query}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub read failed: HTTP ${response.status} ${messageOf(body, "")}`.trim());
    }
    const value = await response.json();
    if (Array.isArray(value) || !value || typeof value !== "object") {
      throw new Error(`GitHub path ${file} is not a file`);
    }
    if (typeof value.content !== "string") {
      throw new Error(`GitHub did not return the file content of ${file}`);
    }
    return {
      data: Buffer.from(value.content.replace(/\s/g, ""), "base64"),
      sha: String(value.sha || ""),
      size: Number(value.size || 0),
    };
  }

  async write(file, bytes, message = "workbuddy-sync: publish") {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.read(file);
      const body = {
        message,
        content: Buffer.from(bytes).toString("base64"),
      };
      if (current?.sha) body.sha = current.sha;
      if (this.branch) body.branch = this.branch;
      const response = await this.request("PUT", `/contents/${encodePath(file)}`, body);
      if (response.ok) {
        const value = await response.json();
        return { sha: String(value?.content?.sha || "") };
      }
      const text = await response.text().catch(() => "");
      lastError = new Error(`GitHub write failed: HTTP ${response.status} ${messageOf(text, "")}`.trim());
      // A racing write (or an outdated sha) is retried after re-reading.
      if (response.status !== 409 && response.status !== 422) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw lastError || new Error("GitHub write failed");
  }
}

export async function createGitHubStore(config) {
  const parsed = config.github || parseGithubURL(config.syncURL);
  const store = new GitHubContents({
    repo: parsed.repo,
    token: config.token,
    branch: config.branch,
  });
  await store.checkPrivate();
  return store;
}
