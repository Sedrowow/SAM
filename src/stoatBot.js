const { moderateMessage } = require("./moderationEngine");
const {
  executeModerationAction,
  escalationFor,
  hasAdminPrivileges,
  hasAdminPrivilegesForMember
} = require("./actions");

const REACTION_APPROVE = "✅";
const REACTION_DISMISS = "🛑";
const REACTION_ESCALATE = "⏫";

function ensureWebSocketGlobal() {
  if (typeof globalThis.WebSocket === "function") {
    return;
  }

  try {
    const ws = require("ws");
    globalThis.WebSocket = ws.WebSocket || ws;
  } catch (error) {
    throw new Error(`WebSocket is unavailable. Install dependency \"ws\": ${error.message}`);
  }
}

function createFlagLogText({ flagId, message, decision, userStats, autoApplied, actionResult }) {
  const lines = [
    "# Flagged Message",
    `Flag ID: ${flagId}`,
    `User: ${message.displayName || message.username} (${message.userId})`,
    `Channel: ${message.channelName || message.channelId}`,
    `Category: ${decision.reason}`,
    `Severity: ${decision.severity}`,
    `Confidence: ${Math.round(decision.confidence * 100)}%`,
    `Suggested action: ${decision.recommendedAction}`,
    `Prior violations: warn=${userStats.warns}, timeout=${userStats.timeouts}, kick=${userStats.kicks}, ban=${userStats.bans}`,
    "",
    "Summary:",
    decision.summary || "No summary",
    "",
    "Reasoning:",
    decision.rationale || "No rationale",
    "",
    "Message sent by user:",
    message.content || "(no content)",
    "",
    autoApplied
      ? `Auto moderation applied: ${actionResult?.action || "n/a"} (${actionResult?.details || ""})`
      : "Resolution: pending moderator action",
    `Controls: ${REACTION_APPROVE} approve suggested action | ${REACTION_DISMISS} dismiss | ${REACTION_ESCALATE} escalate`,
    "Command aliases:",
    "- !mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban",
    "- /mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban",
    "- /approve <flagId> | /dismiss <flagId> | /escalate <flagId>",
    `Example: /approve ${flagId}`
  ];

  return lines.join("\n");
}

function parseModCommand(content) {
  const trimmed = String(content || "").trim();

  if (/^([!/])mod\s+help$/i.test(trimmed)) {
    return { help: true };
  }

  const actionRegex = "(approve|dismiss|escalate|warn|delete|timeout|kick|ban|strict)";

  const matchFlagThenAction = trimmed.match(new RegExp(`^([!/])mod\\s+(\\d+)\\s+${actionRegex}$`, "i"));
  if (matchFlagThenAction) {
    return {
      flagId: Number(matchFlagThenAction[2]),
      command: matchFlagThenAction[3].toLowerCase()
    };
  }

  const matchActionThenFlag = trimmed.match(new RegExp(`^([!/])mod\\s+${actionRegex}\\s+(\\d+)$`, "i"));
  if (matchActionThenFlag) {
    return {
      flagId: Number(matchActionThenFlag[3]),
      command: matchActionThenFlag[2].toLowerCase()
    };
  }

  const matchShortcut = trimmed.match(new RegExp(`^([!/])${actionRegex}\\s+(\\d+)$`, "i"));
  if (matchShortcut) {
    return {
      flagId: Number(matchShortcut[3]),
      command: matchShortcut[2].toLowerCase()
    };
  }

  return null;
}

async function fetchChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }
  return channel;
}

function createStoatBot({ config, db, puter }) {
  let client;

  function getRuntimeSettings() {
    const settings = db.getSettings();
    return {
      ...settings,
      stoatBotToken: settings.stoatBotToken || config.stoatBotToken,
      moderationChannelId: settings.moderationChannelId || config.moderationChannelId,
      puterModel: settings.puterModel || config.puterModel,
      puterTemperature: Number.isFinite(Number(settings.puterTemperature))
        ? Number(settings.puterTemperature)
        : config.puterTemperature,
      recentContextMessages: Math.max(1, Number(settings.recentContextMessages || config.recentContextMessages || 12))
    };
  }

  async function postStartupHealthReport() {
    try {
      const runtime = getRuntimeSettings();
      if (!runtime.moderationChannelId) {
        console.warn("Startup health report skipped: moderationChannelId is not configured.");
        return;
      }

      const moderationChannel = await fetchChannel(client, runtime.moderationChannelId);
      const server = moderationChannel.server;

      if (!server) {
        await moderationChannel.sendMessage(
          "# Sentinel Startup Health\nStatus: degraded\nReason: moderation channel is not a server channel."
        );
        return;
      }

      let botMember = server.member;
      if (!botMember && client.user?.id) {
        botMember = await server.fetchMember(client.user.id).catch(() => null);
      }

      const checks = {
        canViewModChannel: moderationChannel.havePermission("ViewChannel"),
        canReadModChannel: moderationChannel.havePermission("ReadMessageHistory"),
        canSendModChannel: moderationChannel.havePermission("SendMessage"),
        canDeleteMessages: moderationChannel.havePermission("ManageMessages"),
        canTimeout: Boolean(botMember?.hasPermission(server, "TimeoutMembers")),
        canKick: Boolean(botMember?.hasPermission(server, "KickMembers")),
        canBan: Boolean(botMember?.hasPermission(server, "BanMembers"))
      };

      const allGood = Object.values(checks).every(Boolean);
      const status = allGood ? "healthy" : "degraded";
      const asMark = (value) => (value ? "ok" : "missing");

      const lines = [
        "# Sentinel Startup Health",
        `Status: ${status}`,
        `Bot: ${client.user?.username || "unknown"} (${client.user?.id || "n/a"})`,
        `Server: ${server.name} (${server.id})`,
        `Moderation channel: ${moderationChannel.displayName || moderationChannel.name || moderationChannel.id} (${moderationChannel.id})`,
        "",
        "Permission checks:",
        `- ViewChannel: ${asMark(checks.canViewModChannel)}`,
        `- ReadMessageHistory: ${asMark(checks.canReadModChannel)}`,
        `- SendMessage: ${asMark(checks.canSendModChannel)}`,
        `- ManageMessages (delete): ${asMark(checks.canDeleteMessages)}`,
        `- TimeoutMembers: ${asMark(checks.canTimeout)}`,
        `- KickMembers: ${asMark(checks.canKick)}`,
        `- BanMembers: ${asMark(checks.canBan)}`,
        "",
        "Resolution controls:",
        `- ${REACTION_APPROVE} approve suggested action`,
        `- ${REACTION_DISMISS} dismiss`,
        `- ${REACTION_ESCALATE} escalate to stricter action`,
        "",
        "Command aliases:",
        "- !mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban",
        "- /mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban",
        "- /approve <flagId> | /dismiss <flagId> | /escalate <flagId>",
        "- /mod help"
      ];

      await moderationChannel.sendMessage(lines.join("\n"));
    } catch (error) {
      console.error("Startup health report failed:", error.message || error);
    }
  }

  function commandToAction(flag, command) {
    if (command === "approve") {
      return flag.recommended_action;
    }

    if (command === "escalate" || command === "strict") {
      return escalationFor(flag.recommended_action);
    }

    if (command === "dismiss") {
      return "dismiss";
    }

    return command;
  }

  async function executeFlagAction({ flag, action, moderatorUserId, notes }) {
    const channel = await fetchChannel(client, flag.channel_id);
    const server = channel.server;

    if (!server) {
      throw new Error("Target message is not in a server channel");
    }

    const settings = db.getSettings();
    const outcome = await executeModerationAction({
      server,
      channel,
      userId: flag.user_id,
      targetMessageId: flag.discord_message_id,
      action,
      reason: `${flag.reason} | ${flag.rationale || "AI flag"}`,
      timeoutMinutes: settings.timeoutMinutes,
      by: moderatorUserId ? `Moderator ${moderatorUserId}` : "AI"
    });

    db.recordUserAction(flag.guild_id, flag.user_id, action);
    db.updateFlagStatus(flag.id, "acted", action, moderatorUserId || null, notes || outcome.details);
    return outcome;
  }

  async function resolveFlagWithCommand(flag, command, actorUserId, notes) {
    const mapped = commandToAction(flag, command);

    if (mapped === "dismiss") {
      db.updateFlagStatus(flag.id, "dismissed", "none", actorUserId || null, notes || "Dismissed by moderator");
      return { action: "dismiss", success: true, details: "Flag dismissed" };
    }

    if (!mapped || mapped === "none") {
      db.updateFlagStatus(flag.id, "acted", "none", actorUserId || null, notes || "Approved with no action");
      return { action: "none", success: true, details: "Suggested action was none" };
    }

    if (!["warn", "delete", "timeout", "kick", "ban"].includes(mapped)) {
      throw new Error(`Unsupported action: ${mapped}`);
    }

    return executeFlagAction({
      flag,
      action: mapped,
      moderatorUserId: actorUserId,
      notes
    });
  }

  async function handleModCommand(message) {
    const parsed = parseModCommand(message.content);
    if (!parsed) {
      return false;
    }

    if (parsed.help) {
      await message.reply(
        [
          "Usage:",
          "- !mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban",
          "- /mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban",
          "- /approve <flagId> | /dismiss <flagId> | /escalate <flagId>",
          "- /warn <flagId> | /delete <flagId> | /timeout <flagId> | /kick <flagId> | /ban <flagId>"
        ].join("\n")
      );
      return true;
    }

    if (!hasAdminPrivileges(message)) {
      await message.reply("You do not have moderation permissions for this action.");
      return true;
    }

    const flag = db.getFlagById(parsed.flagId);
    if (!flag) {
      await message.reply(`Flag ${parsed.flagId} not found.`);
      return true;
    }

    if (flag.status === "dismissed" || flag.status === "acted") {
      await message.reply(`Flag ${flag.id} is already resolved with status: ${flag.status}.`);
      return true;
    }

    try {
      const result = await resolveFlagWithCommand(
        flag,
        parsed.command,
        message.authorId,
        "Action from Stoat moderation command"
      );
      await message.reply(`Action applied for flag ${flag.id}: ${result.action}. ${result.details}`);
    } catch (error) {
      await message.reply(`Failed to apply action for flag ${flag.id}: ${error.message}`);
    }

    return true;
  }

  async function handleReactionControl(message, userId, emoji) {
    if (!message || !userId || userId === client.user?.id) {
      return;
    }

    const flag = db.getFlagByModerationMessageId(message.id);
    if (!flag || flag.status !== "pending") {
      return;
    }

    const command = emoji === REACTION_APPROVE
      ? "approve"
      : emoji === REACTION_DISMISS
        ? "dismiss"
        : emoji === REACTION_ESCALATE
          ? "escalate"
          : null;

    if (!command) {
      return;
    }

    const channel = await fetchChannel(client, flag.channel_id);
    const server = channel.server;
    if (!server) {
      return;
    }

    const reactorMember = await server.fetchMember(userId).catch(() => null);
    if (!hasAdminPrivilegesForMember(server, reactorMember)) {
      await message.reply(`<@${userId}> you are missing moderation permissions for this action.`);
      return;
    }

    try {
      const result = await resolveFlagWithCommand(
        flag,
        command,
        userId,
        `Action from reaction control (${emoji})`
      );
      await message.reply(`Flag ${flag.id} resolved by <@${userId}>: ${result.action}. ${result.details}`);
    } catch (error) {
      await message.reply(`Flag ${flag.id} could not be resolved: ${error.message}`);
    }
  }

  return {
    get client() {
      return client;
    },

    async start() {
      ensureWebSocketGlobal();

      const sdk = await import("stoat.js");
      const { Client } = sdk;

      client = new Client({ partials: false, eagerFetching: true, autoReconnect: true });

      client.on("ready", async () => {
        const username = client.user?.username || "unknown";
        console.log(`Stoat bot logged in as ${username}`);
        await postStartupHealthReport();
      });

      client.on("error", (error) => {
        console.error("Stoat client error:", error);
      });

      client.on("messageReactionAdd", async (message, userId, emoji) => {
        try {
          await handleReactionControl(message, userId, emoji);
        } catch (error) {
          console.error("Reaction moderation handling failed:", error);
        }
      });

      client.on("messageCreate", async (msg) => {
        if (!msg.server || !msg.authorId) {
          return;
        }

        if (msg.author?.bot || msg.authorId === client.user?.id) {
          return;
        }

        const runtime = getRuntimeSettings();

        if (runtime.moderationChannelId && msg.channelId === runtime.moderationChannelId) {
          const handled = await handleModCommand(msg);
          if (handled) {
            return;
          }
        }

        const settings = runtime;
        if (settings.excludedChannelIds.includes(msg.channelId)) {
          return;
        }

        const messagePayload = {
          discordMessageId: msg.id,
          guildId: msg.server.id,
          channelId: msg.channelId,
          channelName: msg.channel?.displayName || msg.channel?.name || "unknown",
          userId: msg.authorId,
          username: msg.author?.username || "unknown",
          displayName: msg.member?.displayName || msg.author?.displayName || msg.author?.username || "unknown",
          content: msg.content || "",
          createdAt: msg.createdAt.toISOString()
        };

        try {
          db.insertRecentContext({
            guildId: messagePayload.guildId,
            userId: messagePayload.userId,
            discordMessageId: messagePayload.discordMessageId,
            content: messagePayload.content,
            createdAt: messagePayload.createdAt
          });
          db.trimRecentContext();

          const userStats = db.getUserStats(messagePayload.guildId, messagePayload.userId);
          const recentMessages = db.getRecentMessagesForUser(
            messagePayload.guildId,
            messagePayload.userId,
            settings.recentContextMessages
          );

          const decision = await moderateMessage({
            puter,
            model: settings.puterModel,
            temperature: settings.puterTemperature,
            rules: settings.rules,
            message: messagePayload,
            userStats,
            recentMessages,
            settings,
            allowedByCap: (action, cap) => db.allowedByCap(action, cap)
          });

          const messageRowId = db.insertMessage({
            ...messagePayload,
            flagged: decision.flagged,
            flagReason: decision.reason,
            aiConfidence: decision.confidence,
            aiRecommendedAction: decision.recommendedAction,
            aiSummary: decision.summary,
            aiRationale: decision.rationale,
            aiRawJson: decision.rawJson
          });

          if (!decision.flagged) {
            return;
          }

          const flagId = db.createFlag({
            messageRowId,
            discordMessageId: messagePayload.discordMessageId,
            guildId: messagePayload.guildId,
            channelId: messagePayload.channelId,
            userId: messagePayload.userId,
            reason: decision.reason,
            severity: decision.severity,
            confidence: decision.confidence,
            recommendedAction: decision.recommendedAction,
            rationale: `Summary: ${decision.summary || "n/a"}\nReasoning: ${decision.rationale || "n/a"}`
          });

          let autoApplied = false;
          let actionResult = null;

          if (settings.autoModeration && settings.allowedActions.includes(decision.recommendedAction) && decision.recommendedAction !== "none") {
            try {
              const flag = db.getFlagById(flagId);
              actionResult = await resolveFlagWithCommand(
                flag,
                "approve",
                null,
                "Auto-moderation action"
              );
              autoApplied = true;
            } catch (error) {
              db.updateFlagStatus(flagId, "pending", null, null, `Auto-action failed: ${error.message}`);
            }
          }

          if (!settings.moderationChannelId) {
            throw new Error("No moderation channel configured. Set moderationChannelId in dashboard settings.");
          }

          const moderationChannel = await fetchChannel(client, settings.moderationChannelId);
          const posted = await moderationChannel.sendMessage(
            createFlagLogText({
              flagId,
              message: messagePayload,
              decision,
              userStats,
              autoApplied,
              actionResult
            })
          );

          db.setFlagModerationMessage(flagId, posted.id);

          await posted.react(REACTION_APPROVE).catch(() => {});
          await posted.react(REACTION_DISMISS).catch(() => {});
          await posted.react(REACTION_ESCALATE).catch(() => {});
        } catch (error) {
          console.error("Message moderation failed:", error);
          db.insertMessage({
            ...messagePayload,
            flagged: false,
            flagReason: null,
            aiConfidence: null,
            aiRecommendedAction: null,
            aiSummary: "Moderation failed before decision.",
            aiRationale: `AI error: ${error.message}`,
            aiRawJson: null
          });
        }
      });

      const runtime = getRuntimeSettings();
      if (!runtime.stoatBotToken) {
        throw new Error("Missing Stoat bot token. Set stoatBotToken in dashboard settings.");
      }

      await client.loginBot(runtime.stoatBotToken);
    },

    async applyActionForFlag({ flagId, action, moderatorUserId, notes }) {
      const flag = db.getFlagById(flagId);
      if (!flag) {
        throw new Error("Flag not found");
      }

      if (flag.status === "dismissed" || flag.status === "acted") {
        return {
          action: flag.action_taken || "none",
          success: true,
          details: `Flag already resolved with status: ${flag.status}`
        };
      }

      return resolveFlagWithCommand(
        flag,
        String(action || "").toLowerCase(),
        moderatorUserId || null,
        notes || "Applied manually"
      );
    },

    async stop() {
      if (client) {
        await client.logout().catch(() => {});
      }
    }
  };
}

module.exports = {
  createStoatBot
};
