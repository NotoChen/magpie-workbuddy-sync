const content = document.getElementById("content");
const reload = document.getElementById("reload");
const syncNow = document.getElementById("sync-now");
let busy = false;
let refreshing = false;
let takeoverArmed = false;

async function refreshStatus() {
  if (refreshing) return;
  refreshing = true;
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `data.js?ts=${Date.now()}`;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error("status reload failed")); };
      document.head.appendChild(script);
    });
    render();
  } catch {
    // Older hosts or a transient file error: fall back to the page reload.
    location.reload();
  } finally {
    refreshing = false;
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function when(value) {
  if (!value) return "尚未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function roleName(role) {
  return role === "master" ? "主机" : role === "slave" ? "从机" : "未设置";
}

function roleDescription(s) {
  if (s.role === "master") return "本机负责刷新 WorkBuddy 凭据，并把账号发布到 GitHub。";
  if (s.role === "slave") return "本机只接收主机发布的 access token，不参与鉴权刷新。";
  return "非跟随机器默认不参与同步；请在下面选择主机或从机。";
}

function statusTone(s) {
  if (s.role === "unconfigured") return "warn";
  if (s.ok === false) return "bad";
  if (s.warning) return "warn";
  return "ok";
}

function statusTitle(s) {
  if (s.role === "unconfigured") return "请选择角色";
  if (s.ok === false) return "需要处理";
  if (String(s.message || "").startsWith("published")) return "已发布到 GitHub";
  if (String(s.message || "").startsWith("applied")) return "已应用主机的账号";
  return "同步正常";
}

function row(name, value) {
  return `<div class="info-row"><span>${esc(name)}</span><b>${esc(value || "—")}</b></div>`;
}

function stat(name, value) {
  return `<div class="stat"><strong>${esc(value)}</strong><span>${esc(name)}</span></div>`;
}

async function applyOption(command, message) {
  if (busy) return;
  const s = globalThis.WORKBUDDY_SYNC;
  const status = document.getElementById("apply-status");
  if (!s?.machineId) {
    if (status) status.textContent = "状态还没有就绪，请稍后重试。";
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
    setTimeout(() => location.reload(), 1600);
  } catch (e) {
    if (status) status.textContent = `提交失败：${e?.message || e}`;
  } finally {
    busy = false;
  }
}

function applyRole() {
  const select = document.getElementById("role");
  if (!select) return;
  return applyOption({ action: "set-role", role: select.value }, "已提交，Magpie 会重载插件。");
}

function takeover(event) {
  // Leave the destructive action two steps: a stray click must not move the
  // master lease away from a working computer.
  const button = event?.currentTarget;
  if (!takeoverArmed) {
    takeoverArmed = true;
    if (button) button.textContent = "再点一次确认";
    setTimeout(() => {
      takeoverArmed = false;
      if (button?.isConnected) button.textContent = "接管主机";
    }, 5000);
    return;
  }
  takeoverArmed = false;
  return applyOption({ action: "takeover" }, "已申请接管主机；旧主机会在下次发布时发现租约已转移并停止。");
}

function render() {
  takeoverArmed = false;
  const s = globalThis.WORKBUDDY_SYNC;
  if (!s) {
    content.innerHTML = `<section class="banner bad"><span class="dot"></span><div><strong>还没有状态</strong><p>确认 Magpie 已加载插件，并且 <code>sync.json</code> 存在。</p></div></section>`;
    return;
  }
  const tone = statusTone(s);
  const role = roleName(s.role);
  const auto = s.roleSource === "sync.json.followServer" || s.roleSource === "unset";
  const notice = s.error || s.warning || "";
  const roleHint = s.roleSource === "sync.json.followServer"
    ? "跟随 Magpie 的同步设置：当前为从机"
    : s.roleSource === "unset" ? "非跟随机器默认不参与同步；请选择主机或从机" : "已由本机 workbuddy-sync.json 固定";
  content.innerHTML = `
    <section class="banner ${tone}" role="status">
      <span class="dot"></span>
      <div class="banner-text">
        <strong>${esc(statusTitle(s))}</strong>
        <p>${esc(notice || (s.ok === false ? "查看下方状态" : "账号同步链路运行中"))}</p>
      </div>
      <time>${esc(when(s.generatedAt))}</time>
    </section>

    <div class="grid">
      <section class="card">
        <div class="card-head"><h2>同步角色</h2><span class="pill ${s.role === "master" ? "accent" : ""}">${esc(role)}</span></div>
        <p class="hint">${esc(roleDescription(s))}</p>
        <label class="field"><span>这台电脑作为</span>
          <select id="role">
            <option value="auto"${auto ? " selected" : ""}>自动（跟随 sync.json）</option>
            <option value="master"${!auto && s.role === "master" ? " selected" : ""}>主机（master）</option>
            <option value="slave"${!auto && s.role === "slave" ? " selected" : ""}>从机（slave）</option>
          </select>
        </label>
        <div class="form-actions">
          <button type="button" id="apply-role" class="primary">应用角色</button>
          ${s.role === "master" ? "" : '<button type="button" id="takeover" class="quiet">接管主机</button>'}
          <span id="apply-status" class="hint" role="status">只影响这台电脑</span>
        </div>
        <p class="hint role-hint">${esc(roleHint)}</p>
        ${s.role === "master" ? "" : '<p class="hint">“接管主机”会显式覆盖旧主机的租约，适合旧主机已经停机或准备迁移的场景；旧主机下次发布会自动停止。</p>'}
      </section>

      <section class="card">
        <div class="card-head"><h2>账号状态</h2><span class="pill">${esc(s.accountCount || 0)} 个账号</span></div>
        <div class="stats">
          ${stat("WorkBuddy 账号", s.accountCount ?? 0)}
          ${stat("快照 generation", s.generation || 0)}
          ${stat("最后发布", when(s.lastPushAt))}
          ${stat("最后拉取", when(s.lastPullAt))}
        </div>
        <details class="details">
          <summary>连接详情</summary>
          ${row("GitHub 仓库", s.repo)}
          ${row("快照文件", s.path)}
          ${row("分支", s.branch || "默认分支")}
          ${row("主机租约", s.leaseOwner ? `${s.leaseOwner.slice(0, 12)}… · epoch ${s.leaseEpoch || 0}` : "尚未建立")}
          ${row("租约到期", when(s.leaseExpiresAt ? new Date(s.leaseExpiresAt).toISOString() : ""))}
          ${row("机器 ID", s.machineId)}
        </details>
      </section>

      ${s.role === "master" ? `
      <section class="card">
        <div class="card-head"><h2>从机</h2><span class="pill">${esc(s.followerCount || 0)} 台在线${s.followerTotal > s.followerCount ? ` · ${esc(s.followerTotal - s.followerCount)} 台离线` : ""}</span></div>
        ${s.followers?.length ? `<div class="follower-list">${s.followers.map((f) => `<div class="follower${f.online === false ? " offline" : ""}"><b>${esc(f.alias || f.machineId.slice(0, 8))}</b><span>${esc(when(f.lastSeen))}</span></div>`).join("")}</div>` : '<p class="hint">还没有从机上报。从机启动后会自动写一条心跳。</p>'}
        <p class="hint">从机每 ${esc(s.presenceMinutes || 60)} 分钟检查一次，超过 ${esc(s.presenceStaleMinutes || 180)} 分钟未上报会显示为离线。</p>
      </section>` : ""}

      <section class="card full">
        <div class="card-head"><h2>它怎么工作</h2></div>
        <ul class="notes">
          <li><b>主机</b>正常登录 WorkBuddy，官方插件负责唯一一次刷新；本插件把账号加密后发布到 Magpie 已有的 GitHub 同步仓库。</li>
          <li><b>从机</b>只拿到 access token，条目里没有 refresh token；即使误点重新登录，下一轮也会被清理。</li>
          <li>只有账号或 token 变化时才会上传，轮询本身不会产生新 commit；当前快照是整份小文件，不做增量分片。</li>
          <li>WorkBuddy Plus 的定时任务只在主机开启，从机不要重复执行。</li>
          ${s.securityWarning ? `<li class="security-note">${esc(s.securityWarning)}</li>` : ""}
        </ul>
      </section>
    </div>
  `;
  document.getElementById("apply-role")?.addEventListener("click", applyRole);
  document.getElementById("takeover")?.addEventListener("click", takeover);
}

reload.addEventListener("click", () => void refreshStatus());
syncNow.addEventListener("click", () => applyOption({ action: "sync" }, "已请求同步，Magpie 会重载插件并立即拉取/发布。"));
render();
if (globalThis.magpie?.ready) {
  globalThis.magpie.ready.then(() => render()).catch(() => {});
}

// The page is sandboxed and cannot fetch a status endpoint. The host writes
// data.js; reloading that one script keeps status current without a full page
// reload, so scroll position and focus stay intact.
setInterval(() => {
  const active = document.activeElement;
  if (document.hidden || document.querySelector("details[open]")) return;
  if (active && ["SELECT", "INPUT", "TEXTAREA"].includes(active.tagName)) return;
  void refreshStatus();
}, 20_000);
