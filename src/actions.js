function toTimeoutIso(minutes) {
  const durationMs = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Date(Date.now() + durationMs).toISOString();
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

async function sendModerationDmText({ server, channel, userId, text }) {
  const body = String(text || "").trim();
  if (!body) {
    return { sent: false, details: "No DM body provided" };
  }

  const targets = await collectDmTargets({ server, channel, userId });

  for (const target of targets) {
    try {
      const sent = await trySendDmToTarget(target, body);
      if (sent) {
        return { sent: true, details: "DM delivered" };
      }
    } catch {
      // Keep trying other delivery paths.
    }
  }

  return { sent: false, details: "DM delivery unavailable (user DMs may be closed)" };
}

function dispatchModerationDmAsync({ server, channel, userId, dmText, queueDmText, onDmStatus }) {
  // Do not block moderation action execution on DM generation or delivery.
  void (async () => {
    try {
      if (typeof onDmStatus === "function") {
        await onDmStatus("queued", "DM has been queued.");
      }

      let text = String(dmText || "").trim();
      if (!text && typeof queueDmText === "function") {
        const generated = await queueDmText();
        text = String(generated || "").trim();
      }

      if (!text) {
        if (typeof onDmStatus === "function") {
          await onDmStatus("failed", "DM text generation produced empty content.");
        }
        return;
      }

      const dmResult = await sendModerationDmText({ server, channel, userId, text });
      if (typeof onDmStatus === "function") {
        await onDmStatus(dmResult.sent ? "sent" : "failed", dmResult.details);
      }
    } catch (error) {
      if (typeof onDmStatus === "function") {
        await onDmStatus("failed", error?.message || "Unknown DM failure");
      }
      console.warn("Failed to send moderation DM:", error?.message || error);
    }
  })();
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
  dmText = "",
  queueDmText = null,
  onDmStatus = null
}) {
  const normalizedReason = `${by} moderation: ${reason || "Rule violation"}`;

  if (action === "none") {
    return { action: "none", success: true, details: "No action applied" };
  }

  if (action === "warn") {
    dispatchModerationDmAsync({
      server,
      channel,
      userId,
      dmText,
      queueDmText,
      onDmStatus
    });
    return {
      action: "warn",
      success: true,
      details: "Warning recorded. User DM notification queued.",
      dmQueued: true
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
    dispatchModerationDmAsync({
      server,
      channel,
      userId,
      dmText,
      queueDmText,
      onDmStatus
    });
    return {
      action: "delete",
      success: true,
      details: "Flagged message deleted. User DM notification queued.",
      dmQueued: true
    };
  }

  if (action === "timeout") {
    const member = await server.fetchMember(userId).catch(() => null);
    if (!member) {
      throw new Error("Cannot timeout: member not found in server");
    }

    await member.edit({ timeout: toTimeoutIso(timeoutMinutes) });
    dispatchModerationDmAsync({
      server,
      channel,
      userId,
      dmText,
      queueDmText,
      onDmStatus
    });
    return {
      action: "timeout",
      success: true,
      details: `Timed out for ${timeoutMinutes} minutes. User DM notification queued.`,
      dmQueued: true
    };
  }

  if (action === "kick") {
    await server.kickUser(userId);
    dispatchModerationDmAsync({
      server,
      channel,
      userId,
      dmText,
      queueDmText,
      onDmStatus
    });
    return {
      action: "kick",
      success: true,
      details: "User kicked. DM notification queued.",
      dmQueued: true
    };
  }

  if (action === "ban") {
    await server.banUser(userId, { reason: normalizedReason });
    dispatchModerationDmAsync({
      server,
      channel,
      userId,
      dmText,
      queueDmText,
      onDmStatus
    });
    return {
      action: "ban",
      success: true,
      details: "User banned. DM notification queued.",
      dmQueued: true
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
