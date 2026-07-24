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

function hasDecisionShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    value.flagged !== undefined ||
    value.reason !== undefined ||
    value.recommendedAction !== undefined ||
    value.action !== undefined
  );
}

function extractReasoningText(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  return String(
    value?.reasoning ||
    value?.message?.reasoning ||
    value?.result?.reasoning ||
    value?.result?.message?.reasoning ||
    value?.data?.reasoning ||
    value?.data?.message?.reasoning ||
    ""
  ).trim();
}

function decisionPayloadToText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return String(value || "");
  }

  const reasoning = extractReasoningText(value);
  const json = JSON.stringify(value);
  if (reasoning) {
    return `${json}\n\nreasoning:\n${reasoning}`;
  }
  return json;
}

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

  if (typeof rawText === "object") {
    if (Array.isArray(rawText)) {
      const combined = rawText
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (typeof part?.text === "string") {
            return part.text;
          }
          if (typeof part?.content === "string") {
            return part.content;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();

      if (combined) {
        return parseModelJson(combined);
      }
    }

    if (hasDecisionShape(rawText)) {
      return rawText;
    }

    const embeddedText =
      rawText?.message?.content ||
      rawText?.result?.message?.content ||
      rawText?.data?.message?.content ||
      rawText?.choices?.[0]?.message?.content ||
      rawText?.output_text ||
      rawText?.text ||
      null;

    if (embeddedText) {
      return parseModelJson(embeddedText);
    }

    if (rawText.result && typeof rawText.result === "object") {
      return rawText.result;
    }

    return rawText;
  }

  const cleaned = String(rawText)
    .replace(/^```json\s*/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}$/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }

  return JSON.parse(cleaned);
}

async function parseOrRepairDecision({ puter, model, temperature, rawText, message, rules }) {
  let parsed;
  try {
    parsed = parseModelJson(rawText);
  } catch {
    parsed = null;
  }

  if (hasDecisionShape(parsed)) {
    return parsed;
  }

  {
    const repairPrompt = JSON.stringify(
      {
        task: "Convert moderation analysis into strict JSON schema.",
        schema: {
          flagged: "boolean",
          reason: "none|harassment|hate|sexual|violence|self-harm|spam|scam|other",
          severity: "low|medium|high|critical",
          confidence: "number 0..1",
          recommendedAction: "none|warn|delete|timeout|kick|ban",
          summary: "string",
          rationale: "string"
        },
        sourceText: decisionPayloadToText(rawText),
        message: {
          content: message.content,
          channelName: message.channelName,
          username: message.username,
          displayName: message.displayName
        },
        rules
      },
      null,
      2
    );

    const repairResp = await puter.ai.chat(
      [
        {
          role: "system",
          content: "Return ONLY valid JSON matching the schema. Do not include markdown."
        },
        { role: "user", content: repairPrompt }
      ],
      {
        model,
        temperature: Math.min(temperature || 0.1, 0.2),
        max_tokens: 350,
        stream: false,
        response_format: { type: "json_object" }
      }
    );

    const repairedText =
      repairResp?.message?.content?.[0]?.text ||
      repairResp?.message?.content ||
      repairResp?.result?.message?.content ||
      repairResp?.data?.message?.content ||
      repairResp?.result ||
      repairResp;

    const repaired = parseModelJson(repairedText);
    if (hasDecisionShape(repaired)) {
      return repaired;
    }

    throw new Error("AI repair response did not contain a moderation decision shape.");
  }
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
  return {
    ...normalized,
    summary: normalized.summary || summarizeWithContext(message, recentMessages),
    rationale: normalized.rationale || "Model provided no rationale."
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
  let rawModelText = null;

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
        stream: false,
        response_format: { type: "json_object" }
      }
    );

    rawModelText =
      response?.message?.content?.[0]?.text ||
      response?.message?.content ||
      response?.result?.message?.content ||
      response?.data?.message?.content ||
      response?.result ||
      response;

    parsed = await parseOrRepairDecision({
      puter,
      model,
      temperature,
      rawText: rawModelText,
      message,
      rules
    });
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
    rawJson: JSON.stringify(
      parsed || {
        aiError: aiError?.message || null,
        rawModelText: typeof rawModelText === "string"
          ? rawModelText.slice(0, 3000)
          : decisionPayloadToText(rawModelText).slice(0, 3000)
      }
    )
  };
}

module.exports = {
  moderateMessage,
  pickActionWithinPolicy
};
