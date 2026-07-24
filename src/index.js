const { config } = require("./config");
const { createDatabase } = require("./db");
const { createAiClient } = require("./puterClient");
const { createStoatBot } = require("./stoatBot");
const { createDashboard } = require("./dashboard");

function hasRequiredBotSettings(settings) {
  if (!settings.stoatBotToken || !settings.moderationChannelId) {
    return false;
  }

  if (settings.aiProvider === "ollama") {
    return Boolean(settings.ollamaModel && settings.ollamaBaseUrl);
  }

  return Boolean(settings.puterAuthToken);
}

async function main() {
  const db = createDatabase(config.sqlitePath, config.envDefaults);

  let bot = null;

  async function startBotIfConfigured() {
    const settings = db.getSettings();

    if (!hasRequiredBotSettings(settings)) {
      const required = [
        ["stoatBotToken", settings.stoatBotToken],
        ["moderationChannelId", settings.moderationChannelId]
      ];

      if (settings.aiProvider === "ollama") {
        required.push(["ollamaBaseUrl", settings.ollamaBaseUrl]);
        required.push(["ollamaModel", settings.ollamaModel]);
      } else {
        required.push(["puterAuthToken", settings.puterAuthToken]);
      }

      const missing = required
        .filter(([, value]) => !value)
        .map(([name]) => name);

      console.warn(
        `Bot not started. Configure the following in dashboard settings first: ${missing.join(", ")}`
      );
      return false;
    }

    const aiClient = createAiClient(settings);
    bot = createStoatBot({ config, db, puter: aiClient });
    await bot.start();
    return true;
  }

  async function restartBotIfRunning() {
    if (bot) {
      await bot.stop();
      bot = null;
    }
    await startBotIfConfigured();
  }

  const runtime = db.getSettings();

  const dashboard = createDashboard({
    config: {
      dashboardPort: runtime.dashboardPort,
      dashboardHost: runtime.dashboardHost,
      dashboardUsername: runtime.dashboardUsername,
      dashboardPassword: runtime.dashboardPassword
    },
    db,
    onActionRequested: async ({ flagId, action, moderatorUserId }) => {
      if (!bot) {
        throw new Error("Bot is not running. Save valid bot settings and restart the service.");
      }
      return bot.applyActionForFlag({
        flagId,
        action,
        moderatorUserId,
        notes: "Applied from dashboard"
      });
    },
    onSettingsUpdated: async ({ previous, next }) => {
      const loginSettingsChanged =
        previous.stoatBotToken !== next.stoatBotToken ||
        previous.aiProvider !== next.aiProvider ||
        previous.puterAuthToken !== next.puterAuthToken ||
        previous.puterModel !== next.puterModel ||
        previous.ollamaBaseUrl !== next.ollamaBaseUrl ||
        previous.ollamaModel !== next.ollamaModel;

      const botWasConfigured = hasRequiredBotSettings(previous);
      const botNowConfigured = hasRequiredBotSettings(next);

      if (loginSettingsChanged || botWasConfigured !== botNowConfigured) {
        await restartBotIfRunning();
      }
    }
  });

  await startBotIfConfigured();
  dashboard.start();

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down.`);
    if (bot) {
      await bot.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
