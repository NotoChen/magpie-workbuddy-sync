const content = document.getElementById("content");
const reload = document.getElementById("reload");
let busy = false;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function row(name, value, note = "") {
  return `<div class="row"><span class="name">${esc(name)}</span><span class="value">${esc(value || "—")}</span>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
}

function selected(actual, value) {
  return actual === value ? " selected" : "";
}

async function applyOption(command, message) {
  if (busy) return;
  const s = globalThis.WORKBUDDY_SYNC;
  const status = document.getElementById("apply-status");
  if (!s?.machineId) {
    if (status) status.textContent = "状态里没有 machineId，先让插件完成一次加载。";
    return;
  }
  busy = true;
  if (status) status.textContent = "提交中……";
  try {
    const options = (await globalThis.magpie.options.get()) || {};
    await globalThis.magpie.options.set({
      ...options,
      workbuddySyncCommand: { ...command, machine: s.machineId, at: Date.now() },
    });
    if (status) status.textContent = message;
    setTimeout(() => location.reload(), 1800);
  } catch (e) {
    if (status) status.textContent = `提交失败：${e?.message || e}`;
  } finally {
    busy = false;
  }
}

async function applyRole() {
  const select = document.getElementById("role");
  if (!select) return;
  await applyOption({ action: "set-role", role: select.value }, "已提交，Magpie 会重载插件；页面稍后自动刷新。");
}
function render() {
  const s = globalThis.WORKBUDDY_SYNC;
  if (!s) {
    content.innerHTML = `<p class="bad">插件还没有写出状态。确认 Magpie 已加载本插件，并且 <code>sync.json</code> 存在。</p>`;
    return;
  }
  const ok = s.ok !== false;
  const roleLabel = s.role === "master" ? "主机（master）" : s.role === "slave" ? "从机（slave）" : s.role || "未知";
  const roleHint = s.roleSource === "sync.json.followServer"
    ? "自动：sync.json 的 followServer 决定"
    : "已由 workbuddy-sync.json 固定";
  content.innerHTML = `
    <section class="card ${ok ? "ok" : "bad"}">
      <div class="status"><span class="dot"></span><strong>${esc(s.message || (ok ? "正常" : "异常"))}</strong></div>
      ${s.error ? `<p class="bad">${esc(s.error)}</p>` : ""}
      ${s.warning ? `<p class="warn">${esc(s.warning)}</p>` : ""}
      ${s.securityWarning ? `<p class="warn">${esc(s.securityWarning)}</p>` : ""}
      <small>状态时间：${esc(s.generatedAt || "")} · 页面每 20 秒自动刷新</small>
    </section>

    <section class="card">
      <h2>角色</h2>
      ${row("当前角色", roleLabel, roleHint)}
      <div class="role-line">
        <select id="role" aria-label="角色">
          <option value="auto"${selected(s.roleSource === "sync.json.followServer" ? "auto" : "", "auto")}>自动（跟随 sync.json）</option>
          <option value="master"${selected(s.role, "master")}>主机（master）</option>
          <option value="slave"${selected(s.role, "slave")}>从机（slave）</option>
        </select>
        <button type="button" id="apply-role">应用</button>
        <button type="button" id="sync-now">立即同步</button>
      </div>
      <p id="apply-status" class="muted">切换后会写入本机的 <code>workbuddy-sync.json</code>，不会改变其他机器。</p>
    </section>

    <section class="card">
      <h2>同步状态</h2>
      ${row("GitHub 仓库", s.repo)}
      ${row("快照文件", s.path)}
      ${row("分支", s.branch || "默认分支")}
      ${row("WorkBuddy 账号数", s.accountCount)}
      ${row("generation", s.generation)}
      ${row("masterId", s.masterId)}
      ${row("最后发布", s.lastPushAt)}
      ${row("最后拉取", s.lastPullAt)}
    </section>

    <section class="card">
      <h2>说明</h2>
      <p>主机只上传；从机只下载并写入 access token，<b>不保存 refresh token</b>，因此不会参与 WorkBuddy 的鉴权刷新。</p>
      <p>主机发布的是整份加密快照；只有账号或 token 变化时才会上传，未变化不会产生新提交。快照只有几十 KB，不做增量分片。</p>
      <p>从机的 WorkBuddy Plus 不要开启定时任务；任务只在主机跑。</p>
    </section>
  `;
  const button = document.getElementById("apply-role");
  if (button) button.addEventListener("click", applyRole);
  const sync = document.getElementById("sync-now");
  if (sync) sync.addEventListener("click", () => applyOption({ action: "sync" }, "已请求同步，Magpie 会重载插件并立即拉取/发布。"));
}

reload.addEventListener("click", () => location.reload());
render();
if (globalThis.magpie?.ready) {
  globalThis.magpie.ready.then(() => render()).catch(() => {});
}

// The page is sandboxed and cannot fetch a status endpoint. The host writes
// data.js; a light reload keeps the status current without a manual click.
setInterval(() => {
  const active = document.activeElement;
  if (document.hidden || active?.tagName === "SELECT" || active?.tagName === "BUTTON") return;
  location.reload();
}, 20_000);
