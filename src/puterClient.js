const DEFAULT_PUTER_API_ORIGIN = process.env.PUTER_API_ORIGIN || "https://api.puter.com";
const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

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

function normalizeOllamaChatResult(rawResult) {
  const content = pickFirstString([
    rawResult?.message?.content,
    rawResult?.response,
    rawResult?.text,
    typeof rawResult === "string" ? rawResult : ""
  ]);

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
          stream: false,
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.stream !== undefined ? { stream: Boolean(options.stream) } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
          ...(options?.tools ? { tools: options.tools } : {}),
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

async function callOllamaChat({ baseUrl, model, messages, options }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.max_tokens !== undefined ? { num_predict: options.max_tokens } : {})
      }
    })
  });

  const textBody = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status}): ${textBody.slice(0, 300)}`);
  }

  try {
    return JSON.parse(textBody);
  } catch {
    return textBody;
  }
}

function createOllamaClient({ baseUrl, model }) {
  const safeBaseUrl = (baseUrl || DEFAULT_OLLAMA_BASE_URL).trim();
  const safeModel = (model || "llama3.1:8b-instruct").trim();

  if (!safeBaseUrl) {
    throw new Error("Missing Ollama base URL");
  }

  if (!safeModel) {
    throw new Error("Missing Ollama model");
  }

  return {
    ai: {
      async chat(messages, options = {}) {
        const normalizedMessages = Array.isArray(messages)
          ? messages
          : [{ role: "user", content: String(messages || "") }];

        const rawResult = await callOllamaChat({
          baseUrl: safeBaseUrl,
          model: options?.model || safeModel,
          messages: normalizedMessages,
          options
        });

        return normalizeOllamaChatResult(rawResult);
      }
    }
  };
}

function createAiClient(settings = {}) {
  const provider = settings.aiProvider === "ollama" ? "ollama" : "puter";

  if (provider === "ollama") {
    return createOllamaClient({
      baseUrl: settings.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
      model: settings.ollamaModel || "llama3.1:8b-instruct"
    });
  }

  return createPuterClient(settings.puterAuthToken);
}

module.exports = {
  createPuterClient,
  createAiClient
};
