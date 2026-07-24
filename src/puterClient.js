const DEFAULT_PUTER_API_ORIGIN = process.env.PUTER_API_ORIGIN || "https://api.puter.com";

function extractTextFromResponse(result) {
  if (!result) {
    return "";
  }

  if (typeof result?.message?.content === "string") {
    return result.message.content;
  }

  if (Array.isArray(result?.message?.content)) {
    const textParts = result.message.content
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

    return textParts.join("\n");
  }

  if (typeof result?.text === "string") {
    return result.text;
  }

  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

function normalizeChatResult(rawResult) {
  const content = extractTextFromResponse(rawResult);
  return {
    ...rawResult,
    message: {
      ...(rawResult?.message || {}),
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
