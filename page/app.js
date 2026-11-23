const content = document.getElementById("content");
const reload = document.getElementById("reload");
const syncNow = document.getElementById("sync-now");
let busy = false;
let refreshing = false;
let takeoverArmed = false;
let activeTab = "overview";

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

function ago(value) {
  if (!value) return "尚未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function expiryLabel(account) {
  if (!account.expires) return account.type === "api" ? "API Key" : "长期有效";
  if (account.daysLeft < 0) return "已过期";
  if (account.daysLeft === 0) return "今天到期";
  return `${account.daysLeft} 天后到期`;
}

function eventName(type) {
  return ({ publish: "发布", apply: "应用", error: "错误", names: "改名" }[type] || type);
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

async function applyOption(command, message, statusId = "apply-status") {
  if (busy) return;
  const s = globalThis.WORKBUDDY_SYNC;
  const status = document.getElementById(statusId);
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

function saveName() {
  const input = document.getElementById("machine-name");
  if (!input) return;
  return applyOption({ action: "set-name", name: input.value.trim() }, "名称已保存，Magpie 会重载插件。", "name-status");
}

function saveAccountSelection() {
  const accounts = [...document.querySelectorAll(".account-check:checked")].map((input) => input.value);
  if (!accounts.length) {
    const status = document.getElementById("account-status");
    if (status) status.textContent = "至少选择一个账号；否则从机不会收到任何 WorkBuddy 账号。";
    return;
  }
  return applyOption({ action: "set-accounts", accounts }, "账号选择已保存，Magpie 会重载插件。", "account-status");
}

function selectAccounts(all) {
  document.querySelectorAll(".account-check").forEach((input) => { input.checked = all; });
}

async function copyDiagnostics() {
  const s = globalThis.WORKBUDDY_SYNC;
  const button = document.getElementById("copy-diagnostics");
  if (!s) return;
  const text = JSON.stringify(s, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (button) {
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = "复制诊断"; }, 1800);
  }
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
  const tabs = [{ id: "overview", label: "概览" }];
  if (s.role === "master") tabs.push({ id: "accounts", label: "账号" }, { id: "followers", label: "从机" });
  tabs.push({ id: "diagnostics", label: "诊断" });
  if (!tabs.some((tab) => tab.id === activeTab)) activeTab = "overview";

  const roleCard = `
      <section class="card role-card">
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
        <label class="field"><span>本机显示名（用于主机的从机列表）</span>
          <input id="machine-name" type="text" maxlength="80" value="${esc(s.machineName || "")}" placeholder="例如 书房 Mac">
        </label>
        <div class="form-actions">
          <button type="button" id="save-name" class="quiet">保存名称</button>
          <span id="name-status" class="hint" role="status"></span>
        </div>
        ${s.role === "master" ? "" : '<p class="hint">“接管主机”会显式覆盖旧主机的租约，适合旧主机已经停机或准备迁移的场景；旧主机下次发布会自动停止。</p>'}
      </section>`;

  const overviewCard = `
      <section class="card summary-card">
        <div class="card-head"><h2>同步概况</h2><span class="pill ${s.ok ? "accent" : ""}">${esc(statusTitle(s))}</span></div>
        <div class="stats">
          ${stat("WorkBuddy 账号", s.accountCount ?? 0)}
          ${stat("在线从机", s.role === "master" ? (s.followerCount || 0) : "—")}
          ${stat("快照 generation", s.generation || 0)}
          ${stat("最后发布", when(s.lastPushAt))}
        </div>
        <p class="hint">最近检查 ${esc(when(s.lastRunAt))}${s.lastRunMs ? ` · ${esc(s.lastRunMs)} ms` : ""} · 轮询 ${esc(s.pollSeconds || "—")} 秒</p>
      </section>`;

  const accountsPanel = `
      <section class="panel" data-panel="accounts" role="tabpanel" aria-labelledby="tab-accounts"${activeTab === "accounts" ? "" : " hidden"}>
        <section class="card">
          <div class="panel-head">
            <div><h2>账号健康</h2><p class="hint">勾选的账号才会进入 GitHub 快照；未勾选的账号不会出现在从机。</p></div>
            <span class="pill">${esc((s.accountHealth || []).length)} 个账号</span>
          </div>
          ${(s.accountHealth || []).length ? `<div class="account-list">${s.accountHealth.map((a) => `
            <label class="account-row${a.daysLeft !== null && a.daysLeft < 0 ? " expired" : ""}">
              <input type="checkbox" class="account-check" value="${esc(a.key)}"${a.included ? " checked" : ""}>
              <span class="account-main"><b>${esc(a.accountId || a.key)}</b><small>${esc(a.type === "api" ? "API Key" : (a.domain || "OAuth"))}${a.plan ? ` · ${esc(a.plan)}` : ""}</small></span>
              <span class="account-expiry">${esc(expiryLabel(a))}</span>
            </label>`).join("")}</div>
          <div class="account-actions">
            <button type="button" id="select-all-accounts" class="quiet">全选</button>
            <button type="button" id="select-none-accounts" class="quiet">全不选</button>
            <button type="button" id="save-accounts" class="primary">保存选择</button>
            <span id="account-status" class="hint" role="status">选择后 Magpie 会重载插件</span>
          </div>` : '<p class="hint">本机还没有可发布的 WorkBuddy 账号。</p>'}
        </section>
      </section>`;

  const followersPanel = `
      <section class="panel" data-panel="followers" role="tabpanel" aria-labelledby="tab-followers"${activeTab === "followers" ? "" : " hidden"}>
        <section class="card">
          <div class="panel-head">
            <div><h2>从机</h2><p class="hint">从机心跳会显示实际应用的 generation；落后主机会标黄。</p></div>
            <span class="pill">${esc(s.followerCount || 0)} 台在线${s.followerTotal > s.followerCount ? ` · ${esc(s.followerTotal - s.followerCount)} 台离线` : ""}</span>
          </div>
          ${s.followers?.length ? `<div class="follower-list">${s.followers.map((f) => `<div class="follower${f.online === false ? " offline" : ""}">
            <div class="follower-main"><b>${esc(f.alias || f.machineId.slice(0, 8))}</b><span class="${s.generation && f.appliedGeneration && f.appliedGeneration < s.generation ? "behind" : ""}">${esc(f.online === false ? `离线 · ${ago(f.lastSeen)}` : ago(f.lastSeen))} · ${f.appliedGeneration ? `gen ${f.appliedGeneration}` : "未应用"} · ${esc(f.accountCount || 0)} 账号</span></div>
            <div class="follower-edit"><input class="follower-name" type="text" maxlength="80" value="${esc(f.alias || "")}" placeholder="设置名称"><button type="button" class="quiet" data-follower-save data-follower-id="${esc(f.machineId)}">保存</button><span class="hint" id="follower-status-${esc(f.machineId)}"></span></div>
          </div>`).join("")}</div>` : '<p class="hint">还没有从机上报。从机启动后会自动写一条心跳。</p>'}
          <p class="hint">每 ${esc(s.presenceMinutes || 60)} 分钟心跳一次，超过 ${esc(s.presenceStaleMinutes || 180)} 分钟未上报显示离线。</p>
        </section>
      </section>`;

  const diagnosticsPanel = `
      <section class="panel" data-panel="diagnostics" role="tabpanel" aria-labelledby="tab-diagnostics"${activeTab === "diagnostics" ? "" : " hidden"}>
        <div class="panel-head"><div><h2>诊断</h2><p class="hint">只包含状态和诊断信息，不包含 token。</p></div><button type="button" id="copy-diagnostics" class="quiet">复制诊断</button></div>
        <div class="diag-grid">
          <section class="card">
            <div class="card-head"><h2>连接</h2></div>
            ${row("GitHub 仓库", s.repo)}
            ${row("快照文件", s.path)}
            ${row("分支", s.branch || "默认分支")}
            ${row("主机租约", s.leaseOwner ? `${s.leaseOwner.slice(0, 12)}… · epoch ${s.leaseEpoch || 0}` : "尚未建立")}
            ${row("租约到期", when(s.leaseExpiresAt ? new Date(s.leaseExpiresAt).toISOString() : ""))}
            ${row("机器 ID", s.machineId)}
          </section>
          <section class="card">
            <div class="card-head"><h2>运行</h2></div>
            ${row("最近检查", when(s.lastRunAt))}
            ${row("检查耗时", s.lastRunMs ? `${s.lastRunMs} ms` : "—")}
            ${row("轮询间隔", s.pollSeconds ? `${s.pollSeconds} 秒` : "—")}
            ${row("最近成功", when(s.lastSuccessAt))}
            ${row("最近错误", s.lastError ? `${s.lastError} · ${when(s.lastErrorAt)}` : "无")}
          </section>
        </div>
        <section class="card events-card">
          <div class="card-head"><h2>最近事件</h2></div>
          ${(s.events || []).length ? `<ul class="events">${s.events.slice(0, 10).map((e) => `<li><time>${esc(when(e.at))}</time><b>${esc(eventName(e.type))}</b><span>${esc(e.detail || "")}</span></li>`).join("")}</ul>` : '<p class="hint">还没有事件记录。</p>'}
        </section>
        <details class="card notes-card">
          <summary>它怎么工作</summary>
          <ul class="notes">
            <li><b>主机</b>正常登录 WorkBuddy，官方插件负责唯一一次刷新；本插件把账号加密后发布到 Magpie 已有的 GitHub 同步仓库。</li>
            <li><b>从机</b>只拿到 access token，条目里没有 refresh token；即使误点重新登录，下一轮也会被清理。</li>
            <li>只有账号或 token 变化时才会上传，轮询本身不会产生新 commit；当前快照是整份小文件，不做增量分片。</li>
            <li>WorkBuddy Plus 的定时任务只在主机开启，从机不要重复执行。</li>
          </ul>
        </details>
      </section>`;

  content.innerHTML = `
    <section class="banner ${tone}" role="status">
      <span class="dot"></span>
      <div class="banner-text">
        <strong>${esc(statusTitle(s))}</strong>
        <p>${esc(notice || (s.ok === false ? "查看下方诊断" : "账号同步链路运行中"))}</p>
      </div>
      <time>${esc(when(s.generatedAt))}</time>
    </section>

    <nav class="tabs" role="tablist" aria-label="WorkBuddy Sync">
      ${tabs.map((tab) => `<button type="button" class="tab${tab.id === activeTab ? " active" : ""}" data-tab="${tab.id}" role="tab" aria-selected="${tab.id === activeTab}" aria-controls="panel-${tab.id}" id="tab-${tab.id}">${esc(tab.label)}</button>`).join("")}
    </nav>

    <section class="panel" data-panel="overview" role="tabpanel" aria-labelledby="tab-overview"${activeTab === "overview" ? "" : " hidden"}>
      <div class="overview-grid">${roleCard}${overviewCard}</div>
    </section>
    ${s.role === "master" ? accountsPanel + followersPanel : ""}
    ${diagnosticsPanel}
  `;
  content.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab || "overview";
      render();
    });
  });
  document.getElementById("apply-role")?.addEventListener("click", applyRole);
  document.getElementById("takeover")?.addEventListener("click", takeover);
  document.getElementById("save-name")?.addEventListener("click", saveName);
  document.getElementById("save-accounts")?.addEventListener("click", saveAccountSelection);
  document.getElementById("select-all-accounts")?.addEventListener("click", () => selectAccounts(true));
  document.getElementById("select-none-accounts")?.addEventListener("click", () => selectAccounts(false));
  document.getElementById("copy-diagnostics")?.addEventListener("click", () => void copyDiagnostics());
  document.querySelectorAll("[data-follower-save]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.followerId || "";
      const input = button.closest(".follower")?.querySelector(".follower-name");
      return applyOption({ action: "set-follower-name", followerId: id, name: input?.value.trim() || "" }, "已提交，从机下次心跳会使用新名称。", `follower-status-${id}`);
    });
  });
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
