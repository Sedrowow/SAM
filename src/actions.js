function toTimeoutIso(minutes) {
  const durationMs = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Date(Date.now() + durationMs).toISOString();
}

function compactText(text, maxLen = 800) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) {
    return "";
  }
  return value.length > maxLen ? `${value.slice(0, maxLen - 3)}...` : value;
}

async function collectDmTargets({ server, channel, userId }) {
  const targets = [];

  if (server?.fetchMember) {
    const member = await server.fetchMember(userId).catch(() => null);
    if (member) {
      targets.push(member.user, member, member.dmChannel);
    }
  }

  const possibleClients = [
    server?.client,
    channel?.client,
    channel?.server?.client
  ].filter(Boolean);

  for (const client of possibleClients) {
    if (client?.users?.fetch) {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        targets.push(user);
      }
    }
  }

  const seen = new Set();
  return targets.filter((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const key = item.id || `${Object.keys(item).sort().join("|")}:${typeof item.sendMessage}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function trySendDmToTarget(target, text) {
  if (!target) {
    return false;
  }

  if (typeof target.sendMessage === "function") {
    await target.sendMessage(text);
    return true;
  }

  if (typeof target.send === "function") {
    await target.send(text);
    return true;
  }

  if (typeof target.openDM === "function") {
    const dm = await target.openDM();
    if (dm?.sendMessage) {
      await dm.sendMessage(text);
      return true;
    }
  }

  if (typeof target.createDM === "function") {
    const dm = await target.createDM();
    if (dm?.sendMessage) {
      await dm.sendMessage(text);
      return true;
    }
  }

  return false;
}

function buildModerationDm({ action, by, reason, context }) {
  const actionLabel = String(action || "none").toUpperCase();
  const who = by || "Moderation system";
  const reasonSummary = compactText(reason || context?.reasonCategory || "Rule violation", 340);
  const rationale = compactText(context?.rationale || "", 420);

  const lines = [
    "Sentinel Moderation Notice",
    `Action taken: ${actionLabel}`,
    `Decision source: ${who}`,
    context?.flagId ? `Flag ID: ${context.flagId}` : null,
    `Reason: ${reasonSummary}`,
    context?.recommendedAction ? `Original AI recommendation: ${context.recommendedAction}` : null,
    rationale ? `Why: ${rationale}` : null,
    "If you think this was a mistake, contact a server moderator."
  ].filter(Boolean);

  return lines.join("\n");
}

async function sendModerationDm({ server, channel, userId, action, by, reason, context }) {
  const text = buildModerationDm({ action, by, reason, context });
  const targets = await collectDmTargets({ server, channel, userId });

  for (const target of targets) {
    try {
      const sent = await trySendDmToTarget(target, text);
      if (sent) {
        return { sent: true, details: "DM delivered" };
      }
    } catch {
      // Keep trying other delivery paths.
    }
  }

  return { sent: false, details: "DM delivery unavailable (user DMs may be closed)" };
}

async function sendWarning(channel, userId, reason) {
  const text = [
    `<@${userId}> warning issued by moderation.`,
    reason ? `Reason: ${reason}` : "Please review the server rules.",
    "Further violations may lead to stronger actions."
  ].join("\n");

  await channel.sendMessage(text);
}

async function executeModerationAction({
  server,
  channel,
  userId,
  targetMessageId,
  action,
  reason,
  timeoutMinutes,
  by = "AI",
  notificationContext = null
}) {
  const normalizedReason = `${by} moderation: ${reason || "Rule violation"}`;

  if (action === "none") {
    return { action: "none", success: true, details: "No action applied" };
  }

  if (action === "warn") {
    if (!channel) {
      throw new Error("Cannot warn without channel context");
    }
    await sendWarning(channel, userId, normalizedReason);
    const dm = await sendModerationDm({
      server,
      channel,
      userId,
      action,
      by,
      reason: normalizedReason,
      context: notificationContext
    });
    return {
      action: "warn",
      success: true,
      details: `Posted warning mention in channel. ${dm.details}`,
      dmSent: dm.sent
    };
  }

  if (action === "delete") {
    if (!channel || !targetMessageId) {
      throw new Error("Cannot delete without channel and message context");
    }

    const targetMessage = await channel.fetchMessage(targetMessageId).catch(() => null);
    if (!targetMessage) {
      throw new Error("Target message was not found for deletion");
    }

    await targetMessage.delete();
    const dm = await sendModerationDm({
      server,
      channel,
      userId,
      action,
      by,
      reason: normalizedReason,
      context: notificationContext
    });
    return {
      action: "delete",
      success: true,
      details: `Flagged message deleted. ${dm.details}`,
      dmSent: dm.sent
    };
  }

  if (action === "timeout") {
    const member = await server.fetchMember(userId).catch(() => null);
    if (!member) {
      throw new Error("Cannot timeout: member not found in server");
    }

    await member.edit({ timeout: toTimeoutIso(timeoutMinutes) });
    const dm = await sendModerationDm({
      server,
      channel,
      userId,
      action,
      by,
      reason: normalizedReason,
      context: notificationContext
    });
    return {
      action: "timeout",
      success: true,
      details: `Timed out for ${timeoutMinutes} minutes. ${dm.details}`,
      dmSent: dm.sent
    };
  }

  if (action === "kick") {
    await server.kickUser(userId);
    const dm = await sendModerationDm({
      server,
      channel,
      userId,
      action,
      by,
      reason: normalizedReason,
      context: notificationContext
    });
    return {
      action: "kick",
      success: true,
      details: `User kicked. ${dm.details}`,
      dmSent: dm.sent
    };
  }

  if (action === "ban") {
    await server.banUser(userId, { reason: normalizedReason });
    const dm = await sendModerationDm({
      server,
      channel,
      userId,
      action,
      by,
      reason: normalizedReason,
      context: notificationContext
    });
    return {
      action: "ban",
      success: true,
      details: `User banned. ${dm.details}`,
      dmSent: dm.sent
    };
  }

  throw new Error(`Unknown action: ${action}`);
}

function escalationFor(action) {
  switch (action) {
    case "none":
      return "warn";
    case "warn":
      return "delete";
    case "delete":
      return "timeout";
    case "timeout":
      return "kick";
    case "kick":
      return "ban";
    case "ban":
      return "ban";
    default:
      return "timeout";
  }
}

function hasAdminPrivilegesForMember(server, member) {
  if (!server || !member) {
    return false;
  }

  return member.hasPermission(server, "ManageServer") ||
    member.hasPermission(server, "ManageMessages") ||
    member.hasPermission(server, "TimeoutMembers") ||
    member.hasPermission(server, "KickMembers") ||
    member.hasPermission(server, "BanMembers");
}

function hasAdminPrivileges(message) {
  const server = message.server;
  const member = message.member;

  return hasAdminPrivilegesForMember(server, member);
}

module.exports = {
  executeModerationAction,
  escalationFor,
  hasAdminPrivileges,
  hasAdminPrivilegesForMember
};
