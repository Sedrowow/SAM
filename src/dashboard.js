const express = require("express");
const path = require("path");
const basicAuth = require("basic-auth");

function requireAuth(config) {
  return (req, res, next) => {
    const creds = basicAuth(req);
    const current = typeof config === "function" ? config() : config;
    if (!creds || creds.name !== current.dashboardUsername || creds.pass !== current.dashboardPassword) {
      res.set("WWW-Authenticate", 'Basic realm="Moderation Dashboard"');
      return res.status(401).send("Authentication required");
    }
    return next();
  };
}

function parseBooleanQuery(value) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function createDashboard({ config, db, onActionRequested, onSettingsUpdated }) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(requireAuth(() => {
    const settings = db.getSettings();
    return {
      dashboardUsername: settings.dashboardUsername,
      dashboardPassword: settings.dashboardPassword
    };
  }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/stats", (_req, res) => {
    res.json({ stats: db.getStats(), reasonCounts: db.getReasonCounts() });
  });

  app.get("/api/messages", (req, res) => {
    const messages = db.getMessages({
      flagged: parseBooleanQuery(req.query.flagged),
      reason: req.query.reason || undefined,
      serverId: req.query.serverId || undefined,
      limit: req.query.limit || 200
    });
    res.json({ messages });
  });

  app.get("/api/flags", (req, res) => {
    const flags = db.getFlags({
      status: req.query.status || undefined,
      reason: req.query.reason || undefined,
      limit: req.query.limit || 200
    });
    res.json({ flags });
  });

  app.get("/api/users", (req, res) => {
    const users = db.getUsersOverview(req.query.limit || 250);
    res.json({ users });
  });

  app.get("/api/settings", (_req, res) => {
    const settings = db.getSettings();
    res.json({
      settings: {
        ...settings,
        stoatBotToken: settings.stoatBotToken ? "********" : "",
        puterAuthToken: settings.puterAuthToken ? "********" : "",
        dashboardPassword: settings.dashboardPassword ? "********" : ""
      }
    });
  });

  app.post("/api/settings", async (req, res) => {
    const body = req.body || {};
    const current = db.getSettings();

    const providedString = (value, fallback) =>
      typeof value === "string" && value.trim() ? value.trim() : fallback;

    const providedSecret = (value, fallback) => {
      if (typeof value !== "string") {
        return fallback;
      }
      const trimmed = value.trim();
      if (!trimmed || trimmed === "********") {
        return fallback;
      }
      return trimmed;
    };

    const providedNumber = (value, fallback, min = null) => {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return fallback;
      }
      if (Number.isFinite(min)) {
        return Math.max(min, num);
      }
      return num;
    };

    const next = {
      stoatBotToken: providedSecret(body.stoatBotToken, current.stoatBotToken),
      moderationChannelId: providedString(body.moderationChannelId, current.moderationChannelId),
      puterAuthToken: providedSecret(body.puterAuthToken, current.puterAuthToken),
      puterModel: providedString(body.puterModel, current.puterModel),
      puterTemperature: providedNumber(body.puterTemperature, current.puterTemperature),
      recentContextMessages: providedNumber(body.recentContextMessages, current.recentContextMessages, 1),
      autoModeration: typeof body.autoModeration === "boolean" ? body.autoModeration : current.autoModeration,
      allowedActions: Array.isArray(body.allowedActions) && body.allowedActions.length
        ? body.allowedActions
        : current.allowedActions,
      maxAutoAction: typeof body.maxAutoAction === "string" ? body.maxAutoAction : current.maxAutoAction,
      excludedChannelIds: Array.isArray(body.excludedChannelIds) ? body.excludedChannelIds : current.excludedChannelIds,
      timeoutMinutes: providedNumber(body.timeoutMinutes, current.timeoutMinutes, 1),
      dashboardPort: providedNumber(body.dashboardPort, current.dashboardPort, 1),
      dashboardHost: providedString(body.dashboardHost, current.dashboardHost),
      dashboardUsername: providedString(body.dashboardUsername, current.dashboardUsername),
      dashboardPassword: providedSecret(body.dashboardPassword, current.dashboardPassword),
      rules: Array.isArray(body.rules) && body.rules.length ? body.rules : current.rules
    };

    const settings = db.updateSettings(next);

    if (typeof onSettingsUpdated === "function") {
      await onSettingsUpdated({ previous: current, next: settings });
    }

    res.json({
      settings: {
        ...settings,
        stoatBotToken: settings.stoatBotToken ? "********" : "",
        puterAuthToken: settings.puterAuthToken ? "********" : "",
        dashboardPassword: settings.dashboardPassword ? "********" : ""
      }
    });
  });

  app.post("/api/flags/:id/action", async (req, res) => {
    const flagId = Number(req.params.id);
    const action = String(req.body?.action || "");
    const moderatorUserId = String(req.body?.moderatorUserId || "dashboard");

    if (!flagId || !action) {
      return res.status(400).json({ error: "flag id and action are required" });
    }

    try {
      const outcome = await onActionRequested({ flagId, action, moderatorUserId });
      return res.json({ ok: true, outcome });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/db/delete-user-messages", (req, res) => {
    const userId = String(req.body?.userId || "").trim();
    const guildId = String(req.body?.guildId || "").trim() || null;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    try {
      const result = db.deleteMessagesByUser({ userId, guildId });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.use(express.static(path.resolve(process.cwd(), "public")));
  app.get("*", (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), "public", "index.html"));
  });

  return {
    app,
    start() {
      app.listen(config.dashboardPort, config.dashboardHost, () => {
        console.log(
          `Dashboard listening on http://${config.dashboardHost}:${config.dashboardPort}`
        );
      });
    }
  };
}

module.exports = {
  createDashboard
};
