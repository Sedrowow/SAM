const DEFAULT_PUTER_API_ORIGIN = process.env.PUTER_API_ORIGIN || "https://api.puter.com";

function pickFirstString(candidates) {
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) {
      return item;
    }
  }
  return "";
}

function extractTextFromResponse(result) {
  if (!result) {
    return "";
  }

  const direct = pickFirstString([
    result?.message?.content,
    result?.result?.message?.content,
    result?.data?.message?.content,
    result?.text,
    typeof result === "string" ? result : ""
  ]);

  if (direct) {
    return direct;
  }

  const contentCandidates = [
    result?.message?.content,
    result?.result?.message?.content,
    result?.data?.message?.content,
    result?.choices?.[0]?.message?.content,
    result?.result?.choices?.[0]?.message?.content,
    result?.output_text,
    result?.result?.output_text
  ];

  for (const candidate of contentCandidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const textParts = candidate
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean);

    if (textParts.length) {
      return textParts.join("\n");
    }
  }

  return JSON.stringify(result);
}

function normalizeChatResult(rawResult) {
  const content = extractTextFromResponse(rawResult);
  const baseMessage =
    rawResult?.message ||
    rawResult?.result?.message ||
    rawResult?.data?.message ||
    rawResult?.choices?.[0]?.message ||
    rawResult?.result?.choices?.[0]?.message ||
    {};

  return {
    ...rawResult,
    message: {
      ...baseMessage,
      content
    },
    toString() {
      return content;
    },
    valueOf() {
      return content;
    }
  };
}

async function callPuterDriver({ authToken, apiOrigin, iface, service, method, args }) {
  const response = await fetch(`${apiOrigin}/drivers/call`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;actually=json",
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      interface: iface,
      ...(service ? { service } : {}),
      method,
      args,
      auth_token: authToken
    })
  });

  const textBody = await response.text();

  if (!response.ok) {
    throw new Error(`Puter API request failed (${response.status}): ${textBody.slice(0, 300)}`);
  }

  try {
    return JSON.parse(textBody);
  } catch {
    return textBody;
  }
}

function createPuterClient(authToken) {
  if (!authToken) {
    throw new Error("Missing Puter auth token");
  }

  return {
    ai: {
      async chat(messages, options = {}) {
        const args = {
          messages: Array.isArray(messages)
            ? messages
            : [{ role: "user", content: String(messages || "") }],
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
          ...(options?.response_format ? { response_format: options.response_format } : {})
        };

        const rawResult = await callPuterDriver({
          authToken,
          apiOrigin: DEFAULT_PUTER_API_ORIGIN,
          iface: "puter-chat-completion",
          service: "ai-chat",
          method: "complete",
          args
        });

        return normalizeChatResult(rawResult);
      }
    }
  };
}

module.exports = {
  createPuterClient
};
