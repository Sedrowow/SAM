function toTimeoutIso(minutes) {
  const durationMs = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Date(Date.now() + durationMs).toISOString();
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
  by = "AI"
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
    return { action: "warn", success: true, details: "Posted warning mention in channel" };
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
    return { action: "delete", success: true, details: "Flagged message deleted" };
  }

  if (action === "timeout") {
    const member = await server.fetchMember(userId).catch(() => null);
    if (!member) {
      throw new Error("Cannot timeout: member not found in server");
    }

    await member.edit({ timeout: toTimeoutIso(timeoutMinutes) });
    return {
      action: "timeout",
      success: true,
      details: `Timed out for ${timeoutMinutes} minutes`
    };
  }

  if (action === "kick") {
    await server.kickUser(userId);
    return { action: "kick", success: true, details: "User kicked" };
  }

  if (action === "ban") {
    await server.banUser(userId, { reason: normalizedReason });
    return { action: "ban", success: true, details: "User banned" };
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
