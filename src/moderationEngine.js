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

function extractFinalAnswerText(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  const contentCandidates = [
    value?.message?.content,
    value?.result?.message?.content,
    value?.data?.message?.content,
    value?.choices?.[0]?.message?.content,
    value?.result?.choices?.[0]?.message?.content,
    value?.output_text,
    value?.result?.output_text,
    value?.text
  ];

  for (const candidate of contentCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }

    if (Array.isArray(candidate)) {
      const joined = candidate
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

      if (joined) {
        return joined;
      }
    }
  }

  return "";
}

function looksLikePromptOrDeliberation(text) {
  const sample = String(text || "").trim();
  if (!sample) {
    return false;
  }

  return /\b(input|role|task|rules?|server rules|json schema|output\s*:|violation history|recent messages)\b\s*[:#]/i.test(sample) ||
    /\b(i(?:'| a)m going to|i(?:'| a)m thinking|let me think|step by step|chain of thought)\b/i.test(sample);
}

function cleanDisplayText(text, maxLen = 600) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3)}...` : cleaned;
}

function sanitizeImageDescriptionText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }

  const normalized = raw
    .replace(/\r/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const lower = normalized.toLowerCase();
  if (
    lower.startsWith("{\"success\"") ||
    lower.startsWith("{\"result\"") ||
    lower.includes("\"tool_calls\"") ||
    lower.includes("\"reasoning\"") ||
    lower.includes("the user wants a factual description") ||
    lower.includes("analyze the image")
  ) {
    return "";
  }

  const cleaned = normalized
    .replace(/^here(?: is|'s)\s+/i, "")
    .replace(/^image description:?\s*/i, "")
    .replace(/^description:?\s*/i, "")
    .trim();

  if (!cleaned) {
    return "";
  }

  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return cleanDisplayText(firstSentence, 220);
}

function inferDecisionFromReasoning(reasoningText) {
  const text = String(reasoningText || "").trim();
  if (!text) {
    return null;
  }

  const grab = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  };

  const flaggedValue = grab([
    /[`"']?flagged[`"']?\s*[:=]\s*(true|false)/i,
    /\bflagged\b[^\n]{0,20}(true|false)/i
  ]);
  const reasonValue = grab([
    /[`"']?reason[`"']?\s*[:=]\s*[`"']?([a-z-]+)[`"']?/i
  ]);
  const severityValue = grab([
    /[`"']?severity[`"']?\s*[:=]\s*[`"']?([a-z]+)[`"']?/i
  ]);
  const actionValue = grab([
    /[`"']?recommendedAction[`"']?\s*[:=]\s*[`"']?([a-z_-]+)[`"']?/i,
    /recommended\s*action\s*[:=]\s*[`"']?([a-z_-]+)[`"']?/i,
    /[`"']?action[`"']?\s*[:=]\s*[`"']?([a-z_-]+)[`"']?/i
  ]);
  const confidenceValue = grab([
    /[`"']?confidence[`"']?\s*[:=]\s*([01](?:\.\d+)?)/i
  ]);

  const hasAnySignal = Boolean(flaggedValue || reasonValue || severityValue || actionValue || confidenceValue);
  if (!hasAnySignal) {
    return null;
  }

  const flagged = flaggedValue
    ? flaggedValue.toLowerCase() === "true"
    : (reasonValue ? reasonValue.toLowerCase() !== "none" : false);

  const reason = reasonValue ? reasonValue.toLowerCase() : (flagged ? "other" : "none");
  const severity = severityValue ? severityValue.toLowerCase() : (flagged ? "medium" : "low");
  const recommendedAction = actionValue
    ? actionValue.toLowerCase().replace(/_/g, "-")
    : (flagged ? "warn" : "none");
  const confidence = confidenceValue ? Number(confidenceValue) : (flagged ? 0.75 : 0.5);

  const summary = text
    .split("\n")
    .map((line) => line.replace(/^\s*[*\-`]+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .slice(0, 220);

  return {
    flagged,
    reason,
    severity,
    confidence,
    recommendedAction,
    summary,
    rationale: text.slice(0, 1200)
  };
}

function decisionPayloadToText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return String(value || "");
  }

  const finalAnswerText = extractFinalAnswerText(value);
  if (finalAnswerText) {
    return finalAnswerText;
  }

  return JSON.stringify(value);
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
    "Do not reveal hidden chain-of-thought or internal reasoning.",
    "Evaluate whether the message violates the rules and propose an action.",
    "Inspect any attached images together with the message text.",
    "Explicit, sexual, violent, self-harm, or event-related images should be treated as moderation evidence.",
    "When images are attached, describe the visible content in a short imageDescription field, and make the summary reference that visual evidence.",
    "Do not use generic summaries like 'image reviewed' when imageDescription can be provided; the summary must say what is visible.",
    "Take context and prior violations into account.",
    "You must flag direct threats and self-harm encouragement (e.g. 'kys', 'kill yourself').",
    "Always provide both a short summary and a rationale, even when not flagged.",
    "summary must describe the message or attached image evidence and context pattern only; never mention prompt/system/policy formatting.",
    "rationale must explain why it is flagged or not flagged, and why recommendedAction is chosen. Mention what escalate would imply and why the image evidence matters if there is one.",
    "JSON schema:",
    "{",
    '  "flagged": boolean,',
    '  "reason": "none|harassment|hate|sexual|violence|self-harm|spam|scam|other",',
    '  "severity": "low|medium|high|critical",',
    '  "confidence": number,',
    '  "recommendedAction": "none|warn|delete|timeout|kick|ban",',
    '  "imageDescription": string,',
    '  "summary": string,',
    '  "rationale": string',
    "}",
    "Confidence must be between 0 and 1.",
    "If unclear, choose flagged=false and reason=none.",
    "Server rules:",
    rules.map((rule, idx) => `${idx + 1}. ${rule}`).join("\n")
  ].join("\n");
}

function buildModerationUserPayload({ message, userStats, recentMessages, settings, imageAttachments }) {
  const attachmentCount = Array.isArray(imageAttachments) ? imageAttachments.length : 0;
  const hasVisualOnlyContent = attachmentCount > 0 && !String(message.content || "").trim();
  const payload = {
    message: {
      content: hasVisualOnlyContent
        ? "[No text provided. Review the attached image(s) for moderation evidence.]"
        : message.content,
      channelName: message.channelName,
      createdAt: message.createdAt,
      username: message.username,
      displayName: message.displayName,
      attachmentCount,
      hasVisualOnlyContent
    },
    userViolationHistory: userStats,
    userRecentMessages: recentMessages,
    policy: {
      allowedActions: settings.allowedActions,
      maxAutoAction: settings.maxAutoAction,
      autoModeration: settings.autoModeration
    },
    mediaEvidence: Array.isArray(imageAttachments)
      ? imageAttachments.map((attachment, index) => ({
        index: index + 1,
        filename: attachment.filename || null,
        contentType: attachment.contentType || null,
        source: attachment.source || null
      }))
      : []
  };

  return JSON.stringify(payload, null, 2);
}

function buildMultimodalUserMessage({ messageText, imageAttachments, aiProvider }) {
  const attachments = Array.isArray(imageAttachments) ? imageAttachments : [];
  if (!attachments.length) {
    return { role: "user", content: messageText };
  }

  if (aiProvider === "ollama") {
    return {
      role: "user",
      content: messageText,
      images: attachments.map((attachment) => attachment.base64).filter(Boolean)
    };
  }

  return {
    role: "user",
    content: [
      { type: "text", text: messageText },
      ...attachments.map((attachment) => ({
        type: "image_url",
        image_url: {
          url: attachment.dataUrl
        }
      }))
    ]
  };
}

async function generateImageDescription({ puter, model, temperature, imageAttachments, aiProvider }) {
  const attachments = Array.isArray(imageAttachments) ? imageAttachments : [];
  if (!attachments.length) {
    return "";
  }

  const message = buildMultimodalUserMessage({
    messageText: [
      "Describe only what is visibly present in the attached image(s).",
      "Return JSON only in this schema: {\"imageDescription\": string}.",
      "Keep it short, concrete, and factual.",
      "Do not mention policy, safety, moderation, or hidden reasoning."
    ].join("\n"),
    imageAttachments: attachments,
    aiProvider
  });

  const response = await puter.ai.chat(
    [
      {
        role: "system",
        content: "Return only JSON and describe the visible image content factually."
      },
      message
    ],
    {
      model,
      temperature: Math.min(Math.max(Number(temperature ?? 0.1), 0.1), 0.3),
      max_tokens: 120,
      stream: false,
      ...(aiProvider !== "ollama" ? { response_format: { type: "json_object" } } : {})
    }
  );

  const rawText =
    response?.message?.content?.[0]?.text ||
    response?.message?.content ||
    response?.result?.message?.content ||
    response?.data?.message?.content ||
    response?.result ||
    response;

  let parsed;
  try {
    parsed = parseModelJson(rawText);
  } catch {
    parsed = null;
  }

  const description = String(
    parsed?.imageDescription ||
    parsed?.description ||
    parsed?.visualDescription ||
    parsed?.message?.content ||
    parsed?.result?.message?.content ||
    parsed?.data?.message?.content ||
    parsed?.choices?.[0]?.message?.content ||
    parsed?.output_text ||
    parsed?.text ||
    ""
  ).trim();

  return sanitizeImageDescriptionText(description);
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

async function parseOrRepairDecision({ puter, model, temperature, rawText, message, rules, imageAttachments = [] }) {
  let parsed;
  try {
    parsed = parseModelJson(rawText);
  } catch {
    parsed = null;
  }

  if (hasDecisionShape(parsed)) {
    return parsed;
  }

  const finalAnswerText = extractFinalAnswerText(rawText);
  if (finalAnswerText) {
    try {
      const parsedFromContent = parseModelJson(finalAnswerText);
      if (hasDecisionShape(parsedFromContent)) {
        return parsedFromContent;
      }
    } catch {
      // Fall through to repair.
    }

    const inferredFromFinalAnswer = inferDecisionFromReasoning(finalAnswerText);
    if (inferredFromFinalAnswer) {
      return {
        ...inferredFromFinalAnswer,
        summary: "",
        rationale: ""
      };
    }
  }

  const hasVisualOnlyContent = imageAttachments.length > 0 && !String(message.content || "").trim();

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
          imageDescription: "string",
          summary: "string",
          rationale: "string"
        },
        sourceText: decisionPayloadToText(rawText),
        message: {
          content: hasVisualOnlyContent
            ? "[No text provided. Review the attached image(s) for moderation evidence.]"
            : message.content,
          channelName: message.channelName,
          username: message.username,
          displayName: message.displayName,
          attachmentCount: imageAttachments.length,
          hasVisualOnlyContent,
          mediaEvidence: imageAttachments.map((attachment, index) => ({
            index: index + 1,
            filename: attachment.filename || null,
            contentType: attachment.contentType || null,
            source: attachment.source || null
          }))
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

    const inferredFromRepair = inferDecisionFromReasoning(decisionPayloadToText(repairedText));
    if (inferredFromRepair) {
      return {
        ...inferredFromRepair,
        summary: "",
        rationale: ""
      };
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
  const imageDescription = sanitizeImageDescriptionText(String(
    decision.imageDescription ||
    decision.visualDescription ||
    decision.imageSummary ||
    ""
  ).trim());

  return {
    flagged,
    reason,
    severity,
    confidence,
    recommendedAction,
    imageDescription,
    summary,
    rationale: String(decision.rationale || "")
  };
}

function summarizeWithContext(message, recentMessages, attachmentCount = 0, imageDescription = "") {
  const text = String(message?.content || "").trim();
  if (!text) {
    if (attachmentCount > 0) {
      if (imageDescription) {
        return `Attached image${attachmentCount === 1 ? "" : "s"}: ${imageDescription}`;
      }
      return `Attached image${attachmentCount === 1 ? "" : "s"} reviewed.`;
    }
    return "Empty or non-text message.";
  }

  const excerpt = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  const recent = Array.isArray(recentMessages) ? recentMessages : [];
  const recentTexts = recent
    .map((row) => String(row?.content || "").trim())
    .filter(Boolean);
  const recentCount = recentTexts.length;
  const repeated = recentTexts.some((line) => line.toLowerCase() === text.toLowerCase());

  if (!recentCount) {
    return `Message says: "${excerpt}".`;
  }

  if (repeated) {
    return `Message says: "${excerpt}". Context shows repetition of this phrasing in recent messages.`;
  }

  const last = recentTexts[recentTexts.length - 1];
  const lastExcerpt = last.length > 70 ? `${last.slice(0, 67)}...` : last;
  return `Message says: "${excerpt}". Context from ${recentCount} recent message(s), latest was "${lastExcerpt}".`;
}

function escalateAction(action) {
  const path = {
    none: "warn",
    warn: "delete",
    delete: "timeout",
    timeout: "kick",
    kick: "ban",
    ban: "ban"
  };
  return path[action] || "warn";
}

function rationaleTemplate({ flagged, reason, severity, recommendedAction, recentMessages, attachmentCount = 0, imageDescription = "" }) {
  const contextCount = Array.isArray(recentMessages) ? recentMessages.length : 0;
  const escalate = escalateAction(recommendedAction);
  const imageContext = attachmentCount > 0
    ? imageDescription
      ? ` Image evidence: ${imageDescription}.`
      : ` The attached image${attachmentCount === 1 ? " was" : "s were"} also reviewed as moderation evidence.`
    : "";

  if (!flagged) {
    return `No clear policy violation was detected in current context (${contextCount} recent message(s) reviewed). Approve keeps action at ${recommendedAction}. Escalate would move to ${escalate} only if moderators have additional evidence outside the captured context.${imageContext}`;
  }

  return `Flagged for ${reason} with ${severity} severity based on the message and recent context (${contextCount} recent message(s) reviewed). Approve applies ${recommendedAction}. Escalate would move to ${escalate} if moderators judge risk as more severe.${imageContext}`;
}

function applySafetyHeuristics({ message, recentMessages, normalized, attachmentCount = 0 }) {
  const safeSummary = cleanDisplayText(normalized.summary, 260);
  const safeRationale = cleanDisplayText(normalized.rationale, 700);
  const imageDescription = cleanDisplayText(normalized.imageDescription, 220);
  const summaryNeedsImageEvidence = attachmentCount > 0 && (
    !safeSummary ||
    /^(attached image|image reviewed|attached images reviewed|empty or non-text message\.)$/i.test(safeSummary) ||
    (imageDescription && !safeSummary.toLowerCase().includes(imageDescription.slice(0, 20).toLowerCase()))
  );

  const summary = summaryNeedsImageEvidence
    ? summarizeWithContext(message, recentMessages, attachmentCount, imageDescription)
    : (safeSummary && !looksLikePromptOrDeliberation(safeSummary)
      ? safeSummary
      : summarizeWithContext(message, recentMessages, attachmentCount, imageDescription));

  const rationale = safeRationale && !looksLikePromptOrDeliberation(safeRationale)
    ? safeRationale
    : rationaleTemplate({
      flagged: normalized.flagged,
      reason: normalized.reason,
      severity: normalized.severity,
      recommendedAction: normalized.recommendedAction,
      recentMessages,
      attachmentCount,
      imageDescription
    });

  return {
    ...normalized,
    summary,
    rationale
  };
}

async function moderateMessage({
  puter,
  model,
  temperature,
  rules,
  message,
  imageAttachments = [],
  userStats,
  recentMessages,
  settings,
  allowedByCap
}) {
  const systemPrompt = buildSystemPrompt(rules);
  const userPrompt = buildModerationUserPayload({
    message,
    userStats,
    recentMessages,
    settings,
    imageAttachments
  });
  const userMessage = buildMultimodalUserMessage({
    messageText: userPrompt,
    imageAttachments,
    aiProvider: settings.aiProvider
  });

  let parsed = null;
  let normalized = null;
  let aiError = null;
  let rawModelText = null;

  try {
    const response = await puter.ai.chat(
      [
        { role: "system", content: systemPrompt },
        userMessage
      ],
      {
        model,
        temperature,
        max_tokens: 350,
        stream: false,
        ...(settings.aiProvider !== "ollama" ? { response_format: { type: "json_object" } } : {})
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
      rules,
      imageAttachments
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
      imageDescription: "",
      summary: summarizeWithContext(message, recentMessages, imageAttachments.length),
      rationale: `AI unavailable. Using deterministic safety fallback. (${error.message})`
    };
  }

  if (imageAttachments.length && !normalized.imageDescription) {
    try {
      const imageDescription = await generateImageDescription({
        puter,
        model,
        temperature,
        imageAttachments,
        aiProvider: settings.aiProvider
      });
      if (imageDescription) {
        normalized = {
          ...normalized,
          imageDescription
        };
      }
    } catch {
      // Keep moderation running even if the vision-only description step fails.
    }
  }

  const withHeuristics = applySafetyHeuristics({
    message,
    recentMessages,
    normalized,
    attachmentCount: imageAttachments.length
  });

  const policySafeAction = pickActionWithinPolicy(
    withHeuristics.recommendedAction,
    settings.allowedActions,
    settings.maxAutoAction,
    allowedByCap
  );

  return {
    ...withHeuristics,
    summary: withHeuristics.summary || summarizeWithContext(message, recentMessages, imageAttachments.length),
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
