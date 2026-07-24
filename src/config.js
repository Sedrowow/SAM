const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}

function parseList(value, fallback = []) {
  if (!value || !String(value).trim()) {
    return fallback;
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const allowedActions = parseList(process.env.ALLOWED_ACTIONS, ["warn", "delete", "timeout", "kick", "ban"]);

const config = {
  envDefaults: {
    stoatBotToken: process.env.STOAT_BOT_TOKEN || "",
    moderationChannelId: process.env.STOAT_MODERATION_CHANNEL_ID || "",
    aiProvider: process.env.AI_PROVIDER === "ollama" ? "ollama" : "puter",
    puterAuthToken: process.env.PUTER_AUTH_TOKEN || "",
    puterModel: process.env.PUTER_MODEL || "meta-llama/llama-3.1-8b-instruct",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b-instruct",
    puterTemperature: Number(process.env.PUTER_TEMPERATURE || 0.1),
    autoModeration: parseBoolean(process.env.AUTO_MODERATION, false),
    allowedActions,
    maxAutoAction: process.env.MAX_AUTO_ACTION || "delete",
    timeoutMinutes: Number(process.env.DEFAULT_TIMEOUT_MINUTES || 30),
    excludedChannelIds: parseList(process.env.EXCLUDED_CHANNEL_IDS, []),
    recentContextMessages: Number(process.env.RECENT_CONTEXT_MESSAGES || 12),
    dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),
    dashboardHost: process.env.DASHBOARD_HOST || "127.0.0.1",
    dashboardUsername: process.env.DASHBOARD_USERNAME || "admin",
    dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me"
  },

  // These are startup fallbacks; runtime values come from DB settings.
  stoatBotToken: process.env.STOAT_BOT_TOKEN,
  moderationChannelId: process.env.STOAT_MODERATION_CHANNEL_ID,

  aiProvider: process.env.AI_PROVIDER === "ollama" ? "ollama" : "puter",
  puterAuthToken: process.env.PUTER_AUTH_TOKEN,
  puterModel: process.env.PUTER_MODEL || "meta-llama/llama-3.1-8b-instruct",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b-instruct",
  puterTemperature: Number(process.env.PUTER_TEMPERATURE || 0.1),

  autoModeration: parseBoolean(process.env.AUTO_MODERATION, false),
  allowedActions,
  maxAutoAction: process.env.MAX_AUTO_ACTION || "delete",
  defaultTimeoutMinutes: Number(process.env.DEFAULT_TIMEOUT_MINUTES || 30),

  dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),
  dashboardHost: process.env.DASHBOARD_HOST || "127.0.0.1",
  dashboardUsername: process.env.DASHBOARD_USERNAME || "admin",
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me",

  sqlitePath: process.env.SQLITE_PATH
    ? path.resolve(process.cwd(), process.env.SQLITE_PATH)
    : path.resolve(process.cwd(), "data", "moderation.db"),
  recentContextMessages: Number(process.env.RECENT_CONTEXT_MESSAGES || 12)
};

module.exports = {
  config,
  parseBoolean,
  parseList
};
