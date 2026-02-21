const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export async function createChatCompletion({
  apiKey,
  model,
  temperature,
  systemPrompt,
  messages,
  signal
}) {
  const payload = {
    model,
    temperature,
    messages: buildMessages(systemPrompt, messages)
  };

  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const errorText = await safeReadError(response);
    const message = mapHttpError(response.status, errorText);
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No response from model.");
  }

  return content;
}

function buildMessages(systemPrompt, messages) {
  const normalized = messages.map(({ role, content }) => ({ role, content }));
  if (systemPrompt && systemPrompt.trim().length > 0) {
    return [{ role: "system", content: systemPrompt.trim() }, ...normalized];
  }
  return normalized;
}

async function safeReadError(response) {
  try {
    const data = await response.json();
    return data?.error?.message || JSON.stringify(data);
  } catch {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}

function mapHttpError(status, details) {
  if (status === 401) return "Unauthorized. Check your API key in Settings.";
  if (status === 429) return "Too many requests, try again.";
  if (status === 400) return details || "Bad request. Check your prompt or model.";
  if (status >= 500) return "Server error. Please try again later.";
  return details || "Request failed. Please try again.";
}

export { OPENAI_CHAT_URL };
