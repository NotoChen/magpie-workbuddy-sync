const content = document.getElementById("content");
const reload = document.getElementById("reload");
reload.addEventListener("click", () => location.reload());

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function row(name, value, note = "") {
  return `<div class="row"><span class="name">${esc(name)}</span><span class="value">${esc(value || "—")}</span>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
}

function render() {
  const s = globalThis.WORKBUDDY_SYNC;
  if (!s) {
    content.innerHTML = `<p class="bad">插件还没有写出状态。确认 Magpie 已加载本插件，并且 <code>sync.json</code> 存在。</p>`;
    return;
  }
  const ok = s.ok !== false;
  content.innerHTML = `
    <section class="card ${ok ? "ok" : "bad"}">
      <div class="status"><span class="dot"></span><strong>${esc(s.message || (ok ? "正常" : "异常"))}</strong></div>
      ${s.error ? `<p class="bad">${esc(s.error)}</p>` : ""}
      ${s.warning ? `<p class="warn">${esc(s.warning)}</p>` : ""}
      ${s.securityWarning ? `<p class="warn">${esc(s.securityWarning)}</p>` : ""}
      <small>状态时间：${esc(s.generatedAt || "")}</small>
    </section>
    <section class="card">
      ${row("角色", s.role === "master" ? "主机（master）" : s.role === "slave" ? "从机（slave）" : s.role, s.roleSource === "sync.json.followServer" ? "根据 sync.json 的 followServer 自动判断" : "来自 workbuddy-sync.json")}
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
      <p>从机的 WorkBuddy Plus 不要开启定时任务；任务只在主机跑。</p>
    </section>
  `;
}

render();
if (globalThis.magpie?.ready) {
  globalThis.magpie.ready.then(() => render()).catch(() => {});
}
