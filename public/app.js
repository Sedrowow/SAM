async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function qs(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function humanDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString();
}

function severityBadge(text, flagged) {
  if (!text) return "";
  const cls = flagged ? "badge flag" : "badge";
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function actionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function observationStrictness(row) {
  const total = Number(row.totalMessages || 0);
  const flagged = Number(row.flaggedMessages || 0);
  const acted = Number(row.actedFlags || 0);
  const punishments = Number(row.warns || 0) + Number(row.timeouts || 0) + Number(row.kicks || 0) + Number(row.bans || 0);
  const ratio = total > 0 ? flagged / total : 0;

  if (ratio >= 0.45 || acted >= 10 || punishments >= 12) {
    return "strict";
  }
  if (ratio >= 0.2 || acted >= 4 || punishments >= 5) {
    return "moderate";
  }
  return "light";
}

function behaviourSummary(row) {
  const flagged = Number(row.flaggedMessages || 0);
  const total = Number(row.totalMessages || 0);
  const topReason = row.topReason || "none";
  if (total === 0) {
    return "No message history yet.";
  }
  if (flagged === 0) {
    return "No flagged behavior observed so far.";
  }
  return `${flagged}/${total} messages flagged, top risk category: ${topReason}.`;
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function compactCell(value, maxLen = 120) {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return raw.length > maxLen ? `${raw.slice(0, maxLen - 3)}...` : raw;
}

function renderRawDbCompactTable(result) {
  const wrap = qs("rawDbCompactWrap");
  const columns = Array.isArray(result?.columns) ? result.columns : [];
  const rows = Array.isArray(result?.rows) ? result.rows : [];

  if (!columns.length) {
    wrap.innerHTML = "<div class=\"status-text\">No columns returned.</div>";
    return;
  }

  const head = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
  const body = rows.length
    ? rows.map((row) => {
      const tds = columns.map((col) => {
        const full = row?.[col];
        const short = compactCell(full);
        const title = escapeAttr(typeof full === "object" ? JSON.stringify(full) : String(full ?? ""));
        return `<td title="${title}">${escapeHtml(short)}</td>`;
      }).join("");
      return `<tr>${tds}</tr>`;
    }).join("")
    : `<tr><td colspan="${columns.length}">No rows returned.</td></tr>`;

  wrap.innerHTML = `
    <table class="raw-compact-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

async function loadStats() {
  const { stats, reasonCounts } = await api("/api/stats");
  const statsGrid = qs("statsGrid");
  const reasonChips = qs("reasonChips");

  statsGrid.innerHTML = "";
  const cards = [
    ["Total messages", stats.totalMessages],
    ["Flagged messages", stats.flaggedMessages],
    ["Pending flags", stats.pendingFlags],
    ["Acted flags", stats.actedFlags]
  ];

  for (const [label, value] of cards) {
    const el = document.createElement("div");
    el.className = "stat";
    el.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
    statsGrid.appendChild(el);
  }

  reasonChips.innerHTML = "";
  for (const row of reasonCounts) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${row.reason}: ${row.count}`;
    reasonChips.appendChild(chip);
  }
}

async function loadMessages() {
  const flagged = qs("flaggedFilter").value;
  const reason = qs("reasonFilter").value.trim();
  const limit = Number(qs("limitFilter").value || 250);

  const params = new URLSearchParams();
  if (flagged !== "all") params.set("flagged", flagged);
  if (reason) params.set("reason", reason);
  params.set("limit", String(limit));

  const { messages } = await api(`/api/messages?${params.toString()}`);
  const body = qs("messagesBody");
  body.innerHTML = "";

  for (const row of messages) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${humanDate(row.createdAt)}</td>
      <td><code>${escapeHtml(row.displayName || row.username)}</code><br/><code>${escapeHtml(row.userId)}</code></td>
      <td><code>${escapeHtml(row.channelName || row.channelId)}</code></td>
      <td class="message-cell">${escapeHtml(row.content || "")}</td>
      <td>${row.flagged ? severityBadge(row.flagReason, true) : "-"}</td>
      <td>${severityBadge(row.aiRecommendedAction || "none", false)}</td>
      <td class="ai-cell">${escapeHtml(row.aiSummary || "-")}</td>
      <td class="ai-cell">${escapeHtml(row.aiRationale || "-")}</td>
    `;
    body.appendChild(tr);
  }
}

async function takeFlagAction(flagId, action) {
  await api(`/api/flags/${flagId}/action`, {
    method: "POST",
    body: JSON.stringify({ action })
  });
  await Promise.all([loadFlags(), loadStats(), loadMessages()]);
}

async function deleteMessagesForUser(userId, guildId = "") {
  if (!userId) {
    throw new Error("User ID is required");
  }

  await api("/api/db/delete-user-messages", {
    method: "POST",
    body: JSON.stringify({ userId, guildId: guildId || undefined })
  });

  await Promise.all([loadStats(), loadMessages(), loadFlags(), loadUsers()]);
}

async function loadFlags() {
  const { flags } = await api("/api/flags?limit=300");
  const body = qs("flagsBody");
  body.innerHTML = "";

  for (const row of flags) {
    const tr = document.createElement("tr");

    const actionTd = document.createElement("td");
    const actionWrap = document.createElement("div");
    actionWrap.className = "flag-actions";

    if (row.status === "pending") {
      actionWrap.appendChild(
        actionButton("Approve", "btn", () => takeFlagAction(row.id, "approve"))
      );
      actionWrap.appendChild(
        actionButton("Dismiss", "btn btn-ghost", () => takeFlagAction(row.id, "dismiss"))
      );
      actionWrap.appendChild(
        actionButton("Escalate", "btn btn-warning", () => takeFlagAction(row.id, "escalate"))
      );
      actionWrap.appendChild(
        actionButton("Delete", "btn", () => takeFlagAction(row.id, "delete"))
      );
      actionWrap.appendChild(
        actionButton("Warn", "btn", () => takeFlagAction(row.id, "warn"))
      );
      actionWrap.appendChild(
        actionButton("Timeout", "btn btn-warning", () => takeFlagAction(row.id, "timeout"))
      );
      actionWrap.appendChild(
        actionButton("Kick", "btn btn-warning", () => takeFlagAction(row.id, "kick"))
      );
      actionWrap.appendChild(
        actionButton("Ban", "btn btn-danger", () => takeFlagAction(row.id, "ban"))
      );
    } else {
      actionWrap.textContent = "Resolved";
    }

    actionTd.appendChild(actionWrap);

    tr.innerHTML = `
      <td>${humanDate(row.createdAt)}</td>
      <td><code>${escapeHtml(row.displayName || row.username)}</code></td>
      <td>${severityBadge(row.reason, true)}</td>
      <td>${severityBadge(row.severity, false)}</td>
      <td>${severityBadge(row.recommendedAction, false)}</td>
      <td>${severityBadge(row.status, false)}</td>
    `;

    tr.appendChild(actionTd);
    body.appendChild(tr);
  }
}

async function loadUsers() {
  const { users } = await api("/api/users?limit=500");
  const body = qs("usersBody");
  body.innerHTML = "";

  for (const row of users) {
    const strictness = observationStrictness(row);
    const tr = document.createElement("tr");

    const actionTd = document.createElement("td");
    const actionWrap = document.createElement("div");
    actionWrap.className = "flag-actions";
    actionWrap.appendChild(
      actionButton("Delete Messages", "btn btn-danger", async () => {
        const ok = confirm(`Delete all stored messages for user ${row.userId}?`);
        if (!ok) return;
        try {
          await deleteMessagesForUser(row.userId, row.guildId);
        } catch (error) {
          alert(error.message);
        }
      })
    );
    actionTd.appendChild(actionWrap);

    tr.innerHTML = `
      <td><code>${escapeHtml(row.displayName || row.username || row.userId)}</code><br/><code>${escapeHtml(row.userId)}</code></td>
      <td>${escapeHtml(String(row.totalMessages || 0))}</td>
      <td>${escapeHtml(String(row.flaggedMessages || 0))}</td>
      <td>${severityBadge(row.topReason || "none", Boolean(row.topReason && row.topReason !== "none"))}</td>
      <td>${escapeHtml(`w:${row.warns || 0} t:${row.timeouts || 0} k:${row.kicks || 0} b:${row.bans || 0}`)}</td>
      <td class="ai-cell">${escapeHtml(behaviourSummary(row))}</td>
      <td>${severityBadge(strictness, strictness === "strict")}</td>
      <td>${escapeHtml(humanDate(row.lastMessageAt || row.lastFlagAt || ""))}</td>
    `;

    tr.appendChild(actionTd);
    body.appendChild(tr);
  }
}

async function loadSettings() {
  const { settings } = await api("/api/settings");

  qs("stoatBotToken").value = "";
  qs("stoatBotToken").placeholder = settings.stoatBotToken ? "Saved (hidden). Enter to replace." : "Not set";
  qs("moderationChannelId").value = settings.moderationChannelId || "";
  qs("puterAuthToken").value = "";
  qs("puterAuthToken").placeholder = settings.puterAuthToken ? "Saved (hidden). Enter to replace." : "Not set";
  qs("puterModel").value = settings.puterModel || "meta-llama/llama-3.1-8b-instruct";
  qs("puterTemperature").value = String(settings.puterTemperature ?? 0.1);
  qs("recentContextMessages").value = String(settings.recentContextMessages || 12);

  qs("autoModeration").checked = Boolean(settings.autoModeration);
  qs("maxAutoAction").value = settings.maxAutoAction;
  qs("timeoutMinutes").value = String(settings.timeoutMinutes || 30);
  qs("excludedChannels").value = (settings.excludedChannelIds || []).join(",");
  qs("rulesBox").value = (settings.rules || []).join("\n");

  qs("dashboardHost").value = settings.dashboardHost || "127.0.0.1";
  qs("dashboardPort").value = String(settings.dashboardPort || 3000);
  qs("dashboardUsername").value = settings.dashboardUsername || "admin";
  qs("dashboardPassword").value = "";
  qs("dashboardPassword").placeholder = settings.dashboardPassword ? "Saved (hidden). Enter to replace." : "Not set";

  const checks = document.querySelectorAll(".allowedAction");
  checks.forEach((el) => {
    el.checked = (settings.allowedActions || []).includes(el.value);
  });
}

async function saveSettings() {
  const allowedActions = Array.from(document.querySelectorAll(".allowedAction"))
    .filter((el) => el.checked)
    .map((el) => el.value);

  const excludedChannelIds = qs("excludedChannels")
    .value.split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const rules = qs("rulesBox")
    .value.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const payload = {
    stoatBotToken: qs("stoatBotToken").value.trim() || undefined,
    moderationChannelId: qs("moderationChannelId").value.trim(),
    puterAuthToken: qs("puterAuthToken").value.trim() || undefined,
    puterModel: qs("puterModel").value.trim(),
    puterTemperature: Number(qs("puterTemperature").value || 0.1),
    recentContextMessages: Number(qs("recentContextMessages").value || 12),
    autoModeration: qs("autoModeration").checked,
    maxAutoAction: qs("maxAutoAction").value,
    timeoutMinutes: Number(qs("timeoutMinutes").value || 30),
    allowedActions,
    excludedChannelIds,
    rules,
    dashboardHost: qs("dashboardHost").value.trim(),
    dashboardPort: Number(qs("dashboardPort").value || 3000),
    dashboardUsername: qs("dashboardUsername").value.trim(),
    dashboardPassword: qs("dashboardPassword").value.trim() || undefined
  };

  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  qs("saveStatus").textContent = `Saved at ${new Date().toLocaleTimeString()}`;
  qs("stoatBotToken").value = "";
  qs("puterAuthToken").value = "";
  qs("dashboardPassword").value = "";
  await loadStats();
}

async function refreshAll() {
  await Promise.all([loadStats(), loadMessages(), loadFlags(), loadUsers(), loadSettings(), loadRawDbViewer()]);
}

function setupTabs() {
  const buttons = Array.from(document.querySelectorAll(".tab-btn"));
  const panes = Array.from(document.querySelectorAll(".tab-pane"));

  const activate = (id) => {
    for (const btn of buttons) {
      const active = btn.dataset.tab === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }

    for (const pane of panes) {
      pane.classList.toggle("active", pane.id === id);
    }
  };

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });
}

async function deleteMessagesFromDbForm() {
  const userId = qs("dbDeleteUserId").value.trim();
  const guildId = qs("dbDeleteGuildId").value.trim();
  const status = qs("dbDeleteStatus");

  if (!userId) {
    status.textContent = "User ID is required.";
    return;
  }

  const ok = confirm(`Delete messages for user ${userId}? This cannot be undone.`);
  if (!ok) {
    return;
  }

  status.textContent = "Deleting...";
  try {
    const response = await api("/api/db/delete-user-messages", {
      method: "POST",
      body: JSON.stringify({ userId, guildId: guildId || undefined })
    });
    const result = response.result || {};
    status.textContent = `Deleted ${result.messagesDeleted || 0} messages, ${result.flagsDeleted || 0} flags, ${result.contextDeleted || 0} context rows.`;
    await Promise.all([loadStats(), loadMessages(), loadFlags(), loadUsers(), loadRawDbViewer()]);
  } catch (error) {
    status.textContent = `Delete failed: ${error.message}`;
  }
}

async function loadRawDbViewer() {
  const table = qs("rawDbTable").value;
  const limit = Number(qs("rawDbLimit").value || 100);
  const mode = qs("rawDbMode").value;
  const meta = qs("rawDbMeta");
  const output = qs("rawDbOutput");
  const compactWrap = qs("rawDbCompactWrap");

  meta.textContent = "Loading...";
  try {
    const { result } = await api(`/api/db/raw?table=${encodeURIComponent(table)}&limit=${encodeURIComponent(String(limit))}`);
    meta.textContent = `Table: ${result.table} | Rows: ${result.rowCount} | Columns: ${result.columns.length}`;

    if (mode === "json") {
      compactWrap.innerHTML = "";
      output.style.display = "block";
      output.textContent = JSON.stringify(result.rows, null, 2);
    } else {
      output.style.display = "none";
      output.textContent = "";
      renderRawDbCompactTable(result);
    }
  } catch (error) {
    meta.textContent = `Raw view failed: ${error.message}`;
    compactWrap.innerHTML = "";
    output.textContent = "";
    output.style.display = mode === "json" ? "block" : "none";
  }
}

qs("refreshBtn").addEventListener("click", refreshAll);
qs("applyFiltersBtn").addEventListener("click", loadMessages);
qs("saveSettingsBtn").addEventListener("click", saveSettings);
qs("dbDeleteUserMessagesBtn").addEventListener("click", deleteMessagesFromDbForm);
qs("rawDbRefreshBtn").addEventListener("click", loadRawDbViewer);
qs("rawDbMode").addEventListener("change", loadRawDbViewer);

setupTabs();

refreshAll().catch((error) => {
  alert(error.message);
});
