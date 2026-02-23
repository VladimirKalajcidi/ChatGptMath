const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_IMAGE_OCR_PROMPT =
  "Extract all readable text from the image exactly as written. Preserve line breaks.";
const OPENAI_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DEFAULT_VISUAL_SYSTEM_PROMPT = [
  "Do not mention LaTeX, TikZ, source code, or implementation details to the user unless explicitly asked.",
  "Do not output \\documentclass, \\usepackage, \\begin{document}, or \\end{document}.",
  "This chat can render function graphs, but cannot render generic geometry figures reliably.",
  "If user asks to draw geometric figures (triangle, rectangle, circle, polygon, etc.), clearly say you cannot draw geometry figures in this interface and offer textual explanation/solution instead.",
  "If user asks for a function graph, you may include only an axis/function plot block.",
  "For function plots, use:",
  "\\begin{axis}[xmin=...,xmax=...,ymin=...,ymax=...] \\addplot {expression}; \\end{axis}",
  "Do not use ASCII art."
].join("\n");

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
  const normalized = messages.map(({ role, content, attachments, images }) => {
    if (role !== "user") return { role, content };

    const legacyImages = Array.isArray(images)
      ? images.map((dataUrl) => ({
          kind: "image",
          dataUrl,
          name: "image"
        }))
      : [];
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments
      : legacyImages;
    if (normalizedAttachments.length === 0) return { role, content };

    const userText = typeof content === "string" ? content.trim() : "";
    const imageAttachments = normalizedAttachments.filter((file) => {
      if (file.kind !== "image") return false;
      if (typeof file.dataUrl !== "string" || file.dataUrl.length === 0) return false;
      const mimeType = String(file.mimeType || "").toLowerCase();
      if (mimeType.length > 0) return OPENAI_IMAGE_MIME_TYPES.has(mimeType);
      const dataUrlMatch = /^data:([^;]+);base64,/i.exec(file.dataUrl);
      const dataUrlMime = dataUrlMatch ? String(dataUrlMatch[1] || "").toLowerCase() : "";
      return dataUrlMime.length === 0 || OPENAI_IMAGE_MIME_TYPES.has(dataUrlMime);
    });
    const textAttachments = normalizedAttachments.filter(
      (file) => file.kind === "text" && typeof file.extractedText === "string" && file.extractedText.trim().length > 0
    );
    const unsupportedImageAttachments = normalizedAttachments.filter((file) => {
      if (file.kind !== "image") return false;
      const mimeType = String(file.mimeType || "").toLowerCase();
      return mimeType.length > 0 && !OPENAI_IMAGE_MIME_TYPES.has(mimeType);
    });
    const binaryAttachments = normalizedAttachments.filter((file) => file.kind === "binary");

    const textSections = [];
    if (userText.length > 0) {
      textSections.push(userText);
    } else if (imageAttachments.length > 0 && textAttachments.length === 0 && binaryAttachments.length === 0) {
      textSections.push(DEFAULT_IMAGE_OCR_PROMPT);
    }

    if (textAttachments.length > 0) {
      const blocks = textAttachments.map((file, index) => {
        const truncatedLine = file.wasTruncated ? "\n[Truncated file content]" : "";
        return `File ${index + 1}: ${file.name || "text"}\n\`\`\`\n${file.extractedText}${truncatedLine}\n\`\`\``;
      });
      textSections.push(`Attached text files:\n\n${blocks.join("\n\n")}`);
    }

    if (binaryAttachments.length > 0 || unsupportedImageAttachments.length > 0) {
      const list = [...binaryAttachments, ...unsupportedImageAttachments].map((file) => {
        const name = file.name || "file";
        const type = file.mimeType || "application/octet-stream";
        return `- ${name} (${type})`;
      });
      textSections.push(
        `Attached binary files (content not extracted client-side):\n${list.join("\n")}`
      );
    }

    const combinedText = textSections.join("\n\n").trim();
    if (imageAttachments.length === 0) {
      return { role, content: combinedText || content };
    }

    const parts = [];
    if (combinedText.length > 0) {
      parts.push({ type: "text", text: combinedText });
    }
    imageAttachments.forEach((file) => {
      parts.push({
        type: "image_url",
        image_url: { url: file.dataUrl }
      });
    });
    return { role, content: parts };
  });
  const userSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  const mergedSystemPrompt = userSystemPrompt
    ? `${userSystemPrompt}\n\n${DEFAULT_VISUAL_SYSTEM_PROMPT}`
    : DEFAULT_VISUAL_SYSTEM_PROMPT;
  return [{ role: "system", content: mergedSystemPrompt }, ...normalized];
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
