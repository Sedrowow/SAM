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
    "JSON schema:",
    "{",
    '  "flagged": boolean,',
    '  "reason": "none|harassment|hate|sexual|violence|self-harm|spam|scam|other",',
    '  "severity": "low|medium|high|critical",',
    '  "confidence": number,',
    '  "recommendedAction": "none|warn|delete|timeout|kick|ban",',
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
  const flagged = Boolean(decision.flagged);
  const reason = SAFE_REASONS.includes(decision.reason) ? decision.reason : "other";
  const severity = ["low", "medium", "high", "critical"].includes(decision.severity)
    ? decision.severity
    : "medium";
  const confidence = Number.isFinite(Number(decision.confidence))
    ? Math.max(0, Math.min(1, Number(decision.confidence)))
    : 0.5;
  const recommendedAction = ACTIONS.includes(decision.recommendedAction)
    ? decision.recommendedAction
    : flagged
      ? "warn"
      : "none";

  return {
    flagged,
    reason,
    severity,
    confidence,
    recommendedAction,
    rationale: String(decision.rationale || "")
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

  const parsed = parseModelJson(rawText);
  const normalized = normalizeDecision(parsed);
  const policySafeAction = pickActionWithinPolicy(
    normalized.recommendedAction,
    settings.allowedActions,
    settings.maxAutoAction,
    allowedByCap
  );

  return {
    ...normalized,
    recommendedAction: policySafeAction,
    rawJson: JSON.stringify(parsed)
  };
}

module.exports = {
  moderateMessage,
  pickActionWithinPolicy
};
