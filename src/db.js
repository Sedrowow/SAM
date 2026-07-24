const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ACTION_SEVERITY = {
  none: 0,
  warn: 1,
  delete: 2,
  timeout: 3,
  kick: 4,
  ban: 5
};

function ensureDirectoryForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((col) => col.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function createDatabase(dbPath, seedSettings = {}) {
  ensureDirectoryForFile(dbPath);
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      warns INTEGER NOT NULL DEFAULT 0,
      timeouts INTEGER NOT NULL DEFAULT 0,
      kicks INTEGER NOT NULL DEFAULT 0,
      bans INTEGER NOT NULL DEFAULT 0,
      last_action_at TEXT,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_message_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT,
      content TEXT,
      created_at TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0,
      flag_reason TEXT,
      ai_confidence REAL,
      ai_recommended_action TEXT,
      ai_rationale TEXT,
      ai_raw_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_discord_message_id
    ON messages(discord_message_id);

    CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON messages(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_flagged
    ON messages(flagged, flag_reason);

    CREATE TABLE IF NOT EXISTS flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_row_id INTEGER NOT NULL,
      discord_message_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence REAL,
      recommended_action TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      moderator_user_id TEXT,
      moderation_message_id TEXT,
      action_taken TEXT,
      action_notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (message_row_id) REFERENCES messages(id)
    );

    CREATE INDEX IF NOT EXISTS idx_flags_status_created_at
    ON flags(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS recent_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recent_context_lookup
    ON recent_context(guild_id, user_id, created_at DESC);
  `);

  // Backward-compatible schema upgrades.
  ensureColumn(db, "messages", "ai_summary", "TEXT");

  const defaultSettings = {
    stoatBotToken: "",
    moderationChannelId: "",
    puterAuthToken: "",
    puterModel: "meta-llama/llama-3.1-8b-instruct",
    puterTemperature: 0.1,
    recentContextMessages: 12,
    autoModeration: false,
    allowedActions: ["warn", "delete", "timeout", "kick", "ban"],
    maxAutoAction: "delete",
    excludedChannelIds: [],
    timeoutMinutes: 30,
    dashboardPort: 3000,
    dashboardHost: "127.0.0.1",
    dashboardUsername: "admin",
    dashboardPassword: "change-me",
    rules: [
      "No harassment, bullying, or threats.",
      "No hate speech or discrimination.",
      "No sexual content in non-NSFW channels.",
      "No graphic violence or incitement.",
      "No promotion of self-harm.",
      "No spam, scams, phishing, or malicious links."
    ]
  };

  const initialSettings = {
    ...defaultSettings,
    ...seedSettings
  };

  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)`);
  for (const [key, value] of Object.entries(initialSettings)) {
    insertSetting.run(key, JSON.stringify(value));
  }

  return {
    db,

    getSettings() {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      const raw = Object.fromEntries(rows.map((row) => [row.key, safeJsonParse(row.value, row.value)]));
      return {
        stoatBotToken: typeof raw.stoatBotToken === "string" ? raw.stoatBotToken : "",
        moderationChannelId: typeof raw.moderationChannelId === "string" ? raw.moderationChannelId : "",
        puterAuthToken: typeof raw.puterAuthToken === "string" ? raw.puterAuthToken : "",
        puterModel: typeof raw.puterModel === "string" && raw.puterModel
          ? raw.puterModel
          : "meta-llama/llama-3.1-8b-instruct",
        puterTemperature: Number.isFinite(Number(raw.puterTemperature))
          ? Number(raw.puterTemperature)
          : 0.1,
        recentContextMessages: Math.max(1, Number(raw.recentContextMessages || 12)),
        autoModeration: Boolean(raw.autoModeration),
        allowedActions: Array.isArray(raw.allowedActions) ? raw.allowedActions : ["warn", "delete", "timeout", "kick", "ban"],
        maxAutoAction: raw.maxAutoAction || "delete",
        excludedChannelIds: Array.isArray(raw.excludedChannelIds) ? raw.excludedChannelIds : [],
        timeoutMinutes: Number(raw.timeoutMinutes || 30),
        dashboardPort: Math.max(1, Number(raw.dashboardPort || 3000)),
        dashboardHost: typeof raw.dashboardHost === "string" && raw.dashboardHost ? raw.dashboardHost : "127.0.0.1",
        dashboardUsername: typeof raw.dashboardUsername === "string" && raw.dashboardUsername ? raw.dashboardUsername : "admin",
        dashboardPassword: typeof raw.dashboardPassword === "string" && raw.dashboardPassword ? raw.dashboardPassword : "change-me",
        rules: Array.isArray(raw.rules) && raw.rules.length
          ? raw.rules
          : defaultSettings.rules
      };
    },

    updateSettings(nextSettings) {
      const update = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      const tx = db.transaction((payload) => {
        for (const [key, value] of Object.entries(payload)) {
          update.run(key, JSON.stringify(value));
        }
      });
      tx(nextSettings);
      return this.getSettings();
    },

    insertMessage(payload) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO messages (
          discord_message_id, guild_id, channel_id, channel_name, user_id,
          username, display_name, content, created_at,
          flagged, flag_reason, ai_confidence, ai_recommended_action, ai_summary, ai_rationale, ai_raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        payload.discordMessageId,
        payload.guildId,
        payload.channelId,
        payload.channelName,
        payload.userId,
        payload.username,
        payload.displayName,
        payload.content,
        payload.createdAt,
        payload.flagged ? 1 : 0,
        payload.flagReason || null,
        payload.aiConfidence ?? null,
        payload.aiRecommendedAction ?? null,
        payload.aiSummary ?? null,
        payload.aiRationale ?? null,
        payload.aiRawJson ?? null
      );

      return result.lastInsertRowid;
    },

    insertRecentContext(payload) {
      db.prepare(`
        INSERT INTO recent_context(guild_id, user_id, discord_message_id, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(payload.guildId, payload.userId, payload.discordMessageId, payload.content, payload.createdAt);
    },

    getRecentMessagesForUser(guildId, userId, limit = 12) {
      return db.prepare(`
        SELECT content, created_at AS createdAt
        FROM recent_context
        WHERE guild_id = ? AND user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(guildId, userId, limit).reverse();
    },

    trimRecentContext(maxRows = 5000) {
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM recent_context").get();
      const count = Number(countRow?.count || 0);
      if (count <= maxRows) {
        return;
      }
      const toDelete = count - maxRows;
      db.prepare(`DELETE FROM recent_context WHERE id IN (
        SELECT id FROM recent_context ORDER BY created_at ASC LIMIT ?
      )`).run(toDelete);
    },

    getUserStats(guildId, userId) {
      const row = db.prepare(`
        SELECT warns, timeouts, kicks, bans
        FROM users
        WHERE guild_id = ? AND user_id = ?
      `).get(guildId, userId);

      return row || { warns: 0, timeouts: 0, kicks: 0, bans: 0 };
    },

    recordUserAction(guildId, userId, action) {
      db.prepare(`
        INSERT OR IGNORE INTO users(guild_id, user_id) VALUES (?, ?)
      `).run(guildId, userId);

      const field = {
        warn: "warns",
        timeout: "timeouts",
        kick: "kicks",
        ban: "bans"
      }[action];

      if (!field) {
        return;
      }

      db.prepare(`
        UPDATE users
        SET ${field} = ${field} + 1, last_action_at = ?
        WHERE guild_id = ? AND user_id = ?
      `).run(new Date().toISOString(), guildId, userId);
    },

    createFlag(payload) {
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO flags(
          message_row_id,
          discord_message_id,
          guild_id,
          channel_id,
          user_id,
          reason,
          severity,
          confidence,
          recommended_action,
          rationale,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        payload.messageRowId,
        payload.discordMessageId,
        payload.guildId,
        payload.channelId,
        payload.userId,
        payload.reason,
        payload.severity,
        payload.confidence,
        payload.recommendedAction,
        payload.rationale,
        now,
        now
      );

      return result.lastInsertRowid;
    },

    setFlagModerationMessage(flagId, moderationMessageId) {
      db.prepare(`
        UPDATE flags
        SET moderation_message_id = ?, updated_at = ?
        WHERE id = ?
      `).run(moderationMessageId, new Date().toISOString(), flagId);
    },

    updateFlagStatus(flagId, status, actionTaken, moderatorUserId, notes) {
      db.prepare(`
        UPDATE flags
        SET status = ?, action_taken = ?, moderator_user_id = ?, action_notes = ?, updated_at = ?
        WHERE id = ?
      `).run(status, actionTaken || null, moderatorUserId || null, notes || null, new Date().toISOString(), flagId);
    },

    getFlagById(flagId) {
      return db.prepare(`
        SELECT f.*, m.content, m.username, m.display_name, m.channel_name
        FROM flags f
        JOIN messages m ON m.id = f.message_row_id
        WHERE f.id = ?
      `).get(flagId);
    },

    getFlagByModerationMessageId(moderationMessageId) {
      return db.prepare(`
        SELECT f.*, m.content, m.username, m.display_name, m.channel_name
        FROM flags f
        JOIN messages m ON m.id = f.message_row_id
        WHERE f.moderation_message_id = ?
      `).get(moderationMessageId);
    },

    getMessages(filter = {}) {
      const clauses = [];
      const params = [];

      if (filter.flagged === true) {
        clauses.push("flagged = 1");
      } else if (filter.flagged === false) {
        clauses.push("flagged = 0");
      }

      if (filter.reason) {
        clauses.push("flag_reason = ?");
        params.push(filter.reason);
      }

      const scopeId = filter.serverId || filter.guildId;
      if (scopeId) {
        clauses.push("guild_id = ?");
        params.push(scopeId);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.min(Math.max(Number(filter.limit || 200), 1), 1000);

      return db.prepare(`
        SELECT id, discord_message_id AS discordMessageId, guild_id AS guildId,
               channel_id AS channelId, channel_name AS channelName,
               user_id AS userId, username, display_name AS displayName,
               content, created_at AS createdAt, flagged,
               flag_reason AS flagReason, ai_confidence AS aiConfidence,
               ai_recommended_action AS aiRecommendedAction, ai_summary AS aiSummary,
               ai_rationale AS aiRationale
        FROM messages
        ${where}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `).all(...params);
    },

    getFlags(filter = {}) {
      const clauses = [];
      const params = [];

      if (filter.status) {
        clauses.push("f.status = ?");
        params.push(filter.status);
      }
      if (filter.reason) {
        clauses.push("f.reason = ?");
        params.push(filter.reason);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.min(Math.max(Number(filter.limit || 200), 1), 1000);

      return db.prepare(`
        SELECT f.id, f.discord_message_id AS discordMessageId, f.guild_id AS guildId,
               f.channel_id AS channelId, f.user_id AS userId, f.reason,
               f.severity, f.confidence, f.recommended_action AS recommendedAction,
               f.rationale, f.status, f.action_taken AS actionTaken,
               f.moderator_user_id AS moderatorUserId, f.created_at AS createdAt,
               f.updated_at AS updatedAt, f.moderation_message_id AS moderationMessageId,
               m.username, m.display_name AS displayName, m.channel_name AS channelName,
               m.content
        FROM flags f
        JOIN messages m ON m.id = f.message_row_id
        ${where}
        ORDER BY f.created_at DESC
        LIMIT ${limit}
      `).all(...params);
    },

    getReasonCounts() {
      return db.prepare(`
        SELECT flag_reason AS reason, COUNT(*) AS count
        FROM messages
        WHERE flagged = 1
        GROUP BY flag_reason
        ORDER BY count DESC
      `).all();
    },

    getStats() {
      const totalMessages = db.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count || 0;
      const flaggedMessages = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE flagged = 1").get()?.count || 0;
      const pendingFlags = db.prepare("SELECT COUNT(*) AS count FROM flags WHERE status = 'pending'").get()?.count || 0;
      const actedFlags = db.prepare("SELECT COUNT(*) AS count FROM flags WHERE status = 'acted'").get()?.count || 0;

      return {
        totalMessages: Number(totalMessages),
        flaggedMessages: Number(flaggedMessages),
        pendingFlags: Number(pendingFlags),
        actedFlags: Number(actedFlags)
      };
    },

    getUsersOverview(limit = 250) {
      const safeLimit = Math.min(Math.max(Number(limit || 250), 1), 2000);

      return db.prepare(`
        WITH user_base AS (
          SELECT guild_id, user_id FROM messages
          UNION
          SELECT guild_id, user_id FROM users
        ),
        msg_agg AS (
          SELECT guild_id, user_id,
                 COUNT(*) AS totalMessages,
                 SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flaggedMessages,
                 MAX(created_at) AS lastMessageAt,
                 COALESCE(MAX(display_name), MAX(username), user_id) AS displayName,
                 MAX(username) AS username
          FROM messages
          GROUP BY guild_id, user_id
        ),
        flag_agg AS (
          SELECT guild_id, user_id,
                 SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingFlags,
                 SUM(CASE WHEN status = 'acted' THEN 1 ELSE 0 END) AS actedFlags,
                 SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissedFlags,
                 MAX(updated_at) AS lastFlagAt
          FROM flags
          GROUP BY guild_id, user_id
        )
        SELECT
          ub.guild_id AS guildId,
          ub.user_id AS userId,
          COALESCE(ma.displayName, ub.user_id) AS displayName,
          COALESCE(ma.username, ub.user_id) AS username,
          COALESCE(ma.totalMessages, 0) AS totalMessages,
          COALESCE(ma.flaggedMessages, 0) AS flaggedMessages,
          COALESCE(fa.pendingFlags, 0) AS pendingFlags,
          COALESCE(fa.actedFlags, 0) AS actedFlags,
          COALESCE(fa.dismissedFlags, 0) AS dismissedFlags,
          COALESCE(u.warns, 0) AS warns,
          COALESCE(u.timeouts, 0) AS timeouts,
          COALESCE(u.kicks, 0) AS kicks,
          COALESCE(u.bans, 0) AS bans,
          ma.lastMessageAt,
          fa.lastFlagAt,
          (
            SELECT m2.flag_reason
            FROM messages m2
            WHERE m2.guild_id = ub.guild_id
              AND m2.user_id = ub.user_id
              AND m2.flagged = 1
              AND m2.flag_reason IS NOT NULL
            GROUP BY m2.flag_reason
            ORDER BY COUNT(*) DESC, m2.flag_reason ASC
            LIMIT 1
          ) AS topReason
        FROM user_base ub
        LEFT JOIN msg_agg ma ON ma.guild_id = ub.guild_id AND ma.user_id = ub.user_id
        LEFT JOIN flag_agg fa ON fa.guild_id = ub.guild_id AND fa.user_id = ub.user_id
        LEFT JOIN users u ON u.guild_id = ub.guild_id AND u.user_id = ub.user_id
        ORDER BY COALESCE(ma.flaggedMessages, 0) DESC,
                 COALESCE(fa.pendingFlags, 0) DESC,
                 COALESCE(ma.totalMessages, 0) DESC,
                 ub.user_id ASC
        LIMIT ?
      `).all(safeLimit);
    },

    deleteMessagesByUser({ userId, guildId = null }) {
      if (!userId) {
        throw new Error("userId is required");
      }

      const params = guildId ? [guildId, userId] : [userId];
      const where = guildId ? "guild_id = ? AND user_id = ?" : "user_id = ?";

      const tx = db.transaction(() => {
        const messageRowIds = db.prepare(`SELECT id FROM messages WHERE ${where}`).all(...params);
        const ids = messageRowIds.map((row) => row.id);

        let flagsDeleted = 0;
        if (ids.length > 0) {
          const placeholders = ids.map(() => "?").join(", ");
          const result = db.prepare(`DELETE FROM flags WHERE message_row_id IN (${placeholders})`).run(...ids);
          flagsDeleted = result.changes;
        }

        const messagesDeleted = db.prepare(`DELETE FROM messages WHERE ${where}`).run(...params).changes;
        const contextDeleted = db.prepare(`DELETE FROM recent_context WHERE ${where}`).run(...params).changes;

        return {
          messagesDeleted,
          flagsDeleted,
          contextDeleted
        };
      });

      return tx();
    },

    allowedByCap(action, maxAction) {
      return ACTION_SEVERITY[action] <= ACTION_SEVERITY[maxAction];
    }
  };
}

module.exports = {
  createDatabase,
  ACTION_SEVERITY
};
