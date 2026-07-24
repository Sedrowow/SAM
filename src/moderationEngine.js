const SAFE_REASONS = [
  "none",
  "harassment",
  "hate",
  "sexual",
  "violence",
  "self-harm",
  "spam",
  "scam",
  "other"
];

const ACTIONS = ["none", "warn", "delete", "timeout", "kick", "ban"];

const DIRECT_SELF_HARM_PATTERNS = [
  /\bkys\b/i,
  /kill\s+yourself/i,
  /end\s+your\s+life/i,
  /go\s+die/i,
  /hang\s+yourself/i,
  /slit\s+your\s+wrists?/i
];

const DIRECT_THREAT_PATTERNS = [
  /\bi\s*(?:am|m)?\s*going\s*to\s*kill\s+you\b/i,
  /\bi\s*will\s*kill\s+you\b/i,
  /\bkill\s+you\b/i,
  /\bstab\s+you\b/i,
  /\bshoot\s+you\b/i,
  /\bmurder\s+you\b/i,
  /\bbeat\s+you\s+up\b/i
];

function pickActionWithinPolicy(action, allowedActions, maxAutoAction, allowedByCap) {
  if (!ACTIONS.includes(action)) {
    return "warn";
  }

  if (action === "none") {
    return "none";
  }

  if (!allowedActions.includes(action)) {
    const fallback = ["warn", "delete", "timeout", "kick", "ban"].find((candidate) =>
      allowedActions.includes(candidate)
    );
    return fallback || "none";
  }

  if (!allowedByCap(action, maxAutoAction)) {
    const ordered = ["warn", "delete", "timeout", "kick", "ban"];
    const fallback = ordered
      .filter((candidate) => allowedActions.includes(candidate))
      .filter((candidate) => allowedByCap(candidate, maxAutoAction))
      .pop();

    return fallback || "none";
  }

  return action;
}

function buildSystemPrompt(rules) {
  return [
    "You are a strict but fair Stoat moderation assistant.",
    "Return JSON only. No markdown. No prose outside JSON.",
    "Evaluate whether the message violates the rules and propose an action.",
    "Take context and prior violations into account.",
    "You must flag direct threats and self-harm encouragement (e.g. 'kys', 'kill yourself').",
    "Always provide both a short summary and a rationale, even when not flagged.",
    "JSON schema:",
    "{",
    '  "flagged": boolean,',
    '  "reason": "none|harassment|hate|sexual|violence|self-harm|spam|scam|other",',
    '  "severity": "low|medium|high|critical",',
    '  "confidence": number,',
    '  "recommendedAction": "none|warn|delete|timeout|kick|ban",',
    '  "summary": string,',
    '  "rationale": string',
    "}",
    "Confidence must be between 0 and 1.",
    "If unclear, choose flagged=false and reason=none.",
    "Server rules:",
    rules.map((rule, idx) => `${idx + 1}. ${rule}`).join("\n")
  ].join("\n");
}

function parseModelJson(rawText) {
  if (!rawText) {
    throw new Error("Empty AI response");
  }

  const cleaned = String(rawText)
    .replace(/^```json\s*/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

function normalizeDecision(decision) {
  const rawFlagged = decision.flagged ?? decision.isFlagged ?? decision.violates ?? false;
  const flagged = Boolean(rawFlagged);

  const rawReason = String(decision.reason ?? decision.category ?? "other").toLowerCase();
  const reason = SAFE_REASONS.includes(rawReason) ? rawReason : "other";

  const rawSeverity = String(decision.severity ?? "medium").toLowerCase();
  const severity = ["low", "medium", "high", "critical"].includes(rawSeverity)
    ? rawSeverity
    : "medium";

  const rawConfidence = decision.confidence ?? decision.score ?? 0.5;
  const confidence = Number.isFinite(Number(rawConfidence))
    ? Math.max(0, Math.min(1, Number(rawConfidence)))
    : 0.5;

  const actionAliases = {
    mute: "timeout",
    remove: "delete",
    delete_message: "delete"
  };
  const rawAction = String(decision.recommendedAction ?? decision.action ?? "none").toLowerCase();
  const mappedAction = actionAliases[rawAction] || rawAction;
  const recommendedAction = ACTIONS.includes(mappedAction)
    ? mappedAction
    : flagged
      ? "warn"
      : "none";

  const summary = String(decision.summary || decision.brief || "").trim();

  return {
    flagged,
    reason,
    severity,
    confidence,
    recommendedAction,
    summary,
    rationale: String(decision.rationale || "")
  };
}

function summarizeWithContext(message, recentMessages) {
  const text = String(message?.content || "").trim();
  if (!text) {
    return "Empty or non-text message.";
  }

  const excerpt = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  const recentCount = Array.isArray(recentMessages) ? recentMessages.length : 0;
  return recentCount > 0
    ? `Message says: "${excerpt}". Context includes ${recentCount} recent message(s).`
    : `Message says: "${excerpt}".`;
}

function applySafetyHeuristics({ message, recentMessages, normalized }) {
  const text = String(message?.content || "");
  if (!text.trim()) {
    return normalized;
  }

  const lower = text.toLowerCase();
  const hasSelfHarmThreat = DIRECT_SELF_HARM_PATTERNS.some((pattern) => pattern.test(lower));
  const hasDirectThreat = DIRECT_THREAT_PATTERNS.some((pattern) => pattern.test(lower));

  if (!hasSelfHarmThreat && !hasDirectThreat) {
    return {
      ...normalized,
      summary: normalized.summary || summarizeWithContext(message, recentMessages),
      rationale: normalized.rationale || "No explicit policy-triggering threat pattern detected."
    };
  }

  if (hasSelfHarmThreat) {
    return {
      ...normalized,
      flagged: true,
      reason: "self-harm",
      severity: normalized.severity === "critical" ? "critical" : "high",
      confidence: Math.max(normalized.confidence, 0.9),
      recommendedAction: ["delete", "timeout", "kick", "ban"].includes(normalized.recommendedAction)
        ? normalized.recommendedAction
        : "delete",
      summary: "Message contains direct self-harm encouragement or threat language.",
      rationale: "Heuristic override: direct self-harm phrase detected (e.g. 'kys' / 'kill yourself')."
    };
  }

  return {
    ...normalized,
    flagged: true,
    reason: "violence",
    severity: ["high", "critical"].includes(normalized.severity) ? normalized.severity : "high",
    confidence: Math.max(normalized.confidence, 0.85),
    recommendedAction: ["delete", "timeout", "kick", "ban"].includes(normalized.recommendedAction)
      ? normalized.recommendedAction
      : "delete",
    summary: "Message contains direct threat language toward another person.",
    rationale: "Heuristic override: direct violence/threat phrase detected."
  };
}

async function moderateMessage({
  puter,
  model,
  temperature,
  rules,
  message,
  userStats,
  recentMessages,
  settings,
  allowedByCap
}) {
  const systemPrompt = buildSystemPrompt(rules);

  const userPrompt = JSON.stringify(
    {
      message: {
        content: message.content,
        channelName: message.channelName,
        createdAt: message.createdAt,
        username: message.username,
        displayName: message.displayName
      },
      userViolationHistory: userStats,
      userRecentMessages: recentMessages,
      policy: {
        allowedActions: settings.allowedActions,
        maxAutoAction: settings.maxAutoAction,
        autoModeration: settings.autoModeration
      }
    },
    null,
    2
  );

  let parsed = null;
  let normalized = null;
  let aiError = null;

  try {
    const response = await puter.ai.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      {
        model,
        temperature,
        max_tokens: 350,
        response_format: { type: "json_object" }
      }
    );

    const rawText =
      response?.message?.content?.[0]?.text ||
      response?.message?.content ||
      response?.message ||
      response;

    parsed = parseModelJson(rawText);
    normalized = normalizeDecision(parsed);
  } catch (error) {
    aiError = error;
    normalized = {
      flagged: false,
      reason: "none",
      severity: "medium",
      confidence: 0,
      recommendedAction: "none",
      summary: summarizeWithContext(message, recentMessages),
      rationale: `AI unavailable. Using deterministic safety fallback. (${error.message})`
    };
  }

  const withHeuristics = applySafetyHeuristics({
    message,
    recentMessages,
    normalized
  });

  const policySafeAction = pickActionWithinPolicy(
    withHeuristics.recommendedAction,
    settings.allowedActions,
    settings.maxAutoAction,
    allowedByCap
  );

  return {
    ...withHeuristics,
    summary: withHeuristics.summary || summarizeWithContext(message, recentMessages),
    rationale: withHeuristics.rationale || "Model provided no rationale.",
    recommendedAction: policySafeAction,
    rawJson: JSON.stringify(parsed || { aiError: aiError?.message || null })
  };
}

module.exports = {
  moderateMessage,
  pickActionWithinPolicy
};
