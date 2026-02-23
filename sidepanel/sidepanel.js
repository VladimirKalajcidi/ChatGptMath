import { getSettings, getChat, saveChat, clearChat } from "../lib/storage.js";
import { createChatCompletion } from "../lib/openai.js";
import { renderMathInContainer, renderRichContent, renderExternalTikzInContainer } from "../lib/render.js";

const chatEl = document.getElementById("chat");
const composer = document.getElementById("composer-input");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop-stream");
const addFileBtn = document.getElementById("add-file");
const fileInput = document.getElementById("file-input");
const attachmentPreviewList = document.getElementById("attachment-preview-list");
const newChatBtn = document.getElementById("new-chat");
const clearBtn = document.getElementById("clear-chat");
const settingsBtn = document.getElementById("open-settings");
const bannerEl = document.getElementById("banner");

const MAX_ATTACHMENTS = 8;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_EXTRACT_BYTES = 1 * 1024 * 1024;
const MAX_TEXT_CHARS_PER_FILE = 20000;
const MAX_PDF_PAGES = 40;
const MAX_PDF_TEXT_CHARS = 60000;
const TYPING_WORD_DELAY_MS = 24;
const TYPING_PUNCT_DELAY_MS = 72;
const OPENAI_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "heic", "heif", "avif"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "csv", "tsv", "md", "markdown", "rtf", "json", "jsonl", "xml", "yaml", "yml", "ini", "toml", "log", "sql",
  "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "php",
  "rb", "swift", "kt", "kts", "sh", "bash", "zsh", "ps1", "bat"
]);

let settings = null;
let messages = [];
let activeController = null;
let pendingAttachments = [];
let activeTypingRunId = 0;
const pendingTikzHydrationTimers = new Map();

init();

async function init() {
  settings = await getSettings();
  configurePdfJs();
  const chat = await getChat();
  messages = chat.messages || [];
  renderAll();
  setupEvents();
}

function configurePdfJs() {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib || !pdfjsLib.GlobalWorkerOptions) return;
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.js");
  }
}

function setupEvents() {
  sendBtn.addEventListener("click", handleSend);
  addFileBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", handleFileSelection);

  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });

  stopBtn.addEventListener("click", () => {
    activeTypingRunId += 1;
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
    stopBtn.classList.add("hidden");
  });

  newChatBtn.addEventListener("click", async () => {
    messages = [];
    pendingAttachments = [];
    renderAttachmentPreviews();
    await persistChat();
    renderAll();
  });

  clearBtn.addEventListener("click", async () => {
    messages = [];
    pendingAttachments = [];
    renderAttachmentPreviews();
    await clearChat();
    renderAll();
  });

  settingsBtn.addEventListener("click", () => {
    const url = chrome.runtime.getURL("options/options.html");
    chrome.windows.create({
      url,
      type: "popup",
      width: 520,
      height: 720
    });
  });
}

async function handleSend() {
  const typingRunId = activeTypingRunId + 1;
  activeTypingRunId = typingRunId;
  const text = composer.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  const hasUnsupportedImage = pendingAttachments.some((file) => {
    if (file.kind !== "image") return false;
    const mime = String(file.mimeType || "").toLowerCase();
    return mime.length > 0 && !OPENAI_IMAGE_MIME_TYPES.has(mime);
  });
  if (hasUnsupportedImage) {
    showBanner("HEIC/HEIF is not accepted by OpenAI here. Convert image to JPG or PNG and upload again.");
    return;
  }

  settings = await getSettings();
  if (!settings.apiKey) {
    showBanner("Set API key in Settings to start chatting.");
    return;
  }

  hideBanner();
  composer.value = "";

  const attachments = pendingAttachments.map((attachment) => ({
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.size,
    dataUrl: attachment.dataUrl || "",
    extractedText: attachment.extractedText || "",
    wasTruncated: Boolean(attachment.wasTruncated)
  }));

  pendingAttachments = [];
  renderAttachmentPreviews();
  fileInput.value = "";

  const userMessage = createMessage("user", text, attachments);
  messages.push(userMessage);
  await persistChat();
  renderMessage(userMessage);

  const requestMessages = [...messages];
  const assistantMessage = createMessage("assistant", "...");
  messages.push(assistantMessage);
  renderMessage(assistantMessage);
  scrollToBottom();

  try {
    stopBtn.classList.remove("hidden");
    activeController = new AbortController();

    const reply = await createChatCompletion({
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: settings.temperature,
      systemPrompt: settings.systemPrompt,
      messages: requestMessages,
      signal: activeController.signal
    });

    assistantMessage.content = "";
    updateMessage(assistantMessage);
    await typeAssistantReply(assistantMessage, reply, typingRunId);
  } catch (error) {
    if (error.name === "AbortError") {
      assistantMessage.content = "Request cancelled.";
    } else {
      assistantMessage.content = error.message || "Something went wrong.";
    }
  } finally {
    activeController = null;
    stopBtn.classList.add("hidden");
    await persistChat();
    updateMessage(assistantMessage);
    scrollToBottom();
  }
}

async function typeAssistantReply(message, fullText, typingRunId) {
  const text = String(fullText || "");
  if (!text) return;

  const tokens = text.match(/\S+\s*|\n+/g) || [text];
  let acc = "";
  for (const token of tokens) {
    if (typingRunId !== activeTypingRunId) return;
    acc += token;
    message.content = acc;
    updateMessage(message);
    scrollToBottom();
    await delay(getTokenDelay(token));
  }
  message.content = text;
}

function getTokenDelay(token) {
  if (/[.!?]\s*$/.test(token)) return TYPING_PUNCT_DELAY_MS;
  if (/[,;:]\s*$/.test(token)) return Math.max(40, Math.floor(TYPING_PUNCT_DELAY_MS * 0.75));
  return TYPING_WORD_DELAY_MS;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMessage(role, content, attachments = []) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    attachments: Array.isArray(attachments) ? attachments : [],
    createdAt: new Date().toISOString()
  };
}

async function persistChat() {
  const sanitizedMessages = messages.map((message) => {
    const summary = buildAttachmentSummary(message.attachments || []);
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      attachmentSummary: summary
    };
  });
  await saveChat({ messages: sanitizedMessages });
}

function buildAttachmentSummary(attachments) {
  const normalized = Array.isArray(attachments) ? attachments : [];
  const imageCount = normalized.filter((file) => file.kind === "image").length;
  const textCount = normalized.filter((file) => file.kind === "text").length;
  const binaryCount = normalized.filter((file) => file.kind === "binary").length;
  const names = normalized.map((file) => file.name).filter(Boolean).slice(0, 5);
  return {
    total: normalized.length,
    imageCount,
    textCount,
    binaryCount,
    names
  };
}

async function handleFileSelection(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  const freeSlots = Math.max(0, MAX_ATTACHMENTS - pendingAttachments.length);
  if (freeSlots === 0) {
    showBanner(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
    fileInput.value = "";
    return;
  }

  const accepted = files.slice(0, freeSlots);
  if (accepted.length < files.length) {
    showBanner(`Only ${MAX_ATTACHMENTS} files are allowed per message.`);
  }

  const loaded = [];
  for (const file of accepted) {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      showBanner(`File too large: ${file.name}. Max size is 20MB.`);
      continue;
    }

    try {
      const attachment = await convertFileToAttachment(file);
      loaded.push(attachment);
    } catch (error) {
      loaded.push(buildBinaryAttachment(file));
      showBanner(error?.message || `Failed to process ${file.name}. Added as file without preview conversion.`);
    }
  }

  if (loaded.length > 0) {
    pendingAttachments = [...pendingAttachments, ...loaded];
    hideBanner();
    renderAttachmentPreviews();
  }

  fileInput.value = "";
}

async function convertFileToAttachment(file) {
  const extension = getExtension(file.name);
  const mimeType = file.type || "application/octet-stream";

  if (isImageFile(file, extension)) {
    let normalizedImage = null;
    try {
      normalizedImage = await normalizeImageForOpenAi(file, extension, mimeType);
    } catch (error) {
      const isHeic = extension === "heic" || extension === "heif" || String(mimeType).toLowerCase().includes("heic") || String(mimeType).toLowerCase().includes("heif");
      if (!isHeic) {
        throw error;
      }
      // Fallback: keep HEIC as binary attachment to avoid API 400 on unsupported image format.
      return {
        id: crypto.randomUUID(),
        name: file.name || "image.heic",
        mimeType: String(mimeType || "").toLowerCase().includes("heif") ? "image/heif" : "image/heic",
        size: file.size,
        kind: "binary",
        badgeLabel: formatBadgeLabel(extension, "file"),
        conversionRequired: true
      };
    }
    return {
      id: crypto.randomUUID(),
      name: file.name || "image",
      mimeType: normalizedImage.mimeType,
      size: file.size,
      kind: "image",
      dataUrl: normalizedImage.dataUrl
    };
  }

  if (isPdfFile(file, extension)) {
    const extracted = await extractPdfText(file);
    if (extracted && extracted.text.trim().length > 0) {
      return {
        id: crypto.randomUUID(),
        name: file.name || "document.pdf",
        mimeType,
        size: file.size,
        kind: "text",
        extractedText: extracted.text,
        wasTruncated: extracted.wasTruncated
      };
    }
    return {
      id: crypto.randomUUID(),
      name: file.name || "document.pdf",
      mimeType,
      size: file.size,
      kind: "binary"
    };
  }

  if (isTextFile(file, extension)) {
    const raw = await file.text();
    const wasTruncatedByBytes = file.size > MAX_TEXT_EXTRACT_BYTES;
    const trimmedByChars = raw.length > MAX_TEXT_CHARS_PER_FILE;
    const extractedText = raw.slice(0, MAX_TEXT_CHARS_PER_FILE);

    return {
      id: crypto.randomUUID(),
      name: file.name || "text",
      mimeType,
      size: file.size,
      kind: "text",
      extractedText,
      wasTruncated: wasTruncatedByBytes || trimmedByChars
    };
  }

  return {
    id: crypto.randomUUID(),
    name: file.name || "file",
    mimeType,
    size: file.size,
    kind: "binary",
    badgeLabel: formatBadgeLabel(extension, "file")
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Invalid file content."));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("Read failed."));
    reader.readAsDataURL(file);
  });
}

function isImageFile(file, extension) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  if (type === "application/octet-stream" && (extension === "heic" || extension === "heif")) return true;
  return IMAGE_EXTENSIONS.has(extension);
}

async function normalizeImageForOpenAi(file, extension, mimeType) {
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (OPENAI_IMAGE_MIME_TYPES.has(normalizedMime)) {
    return {
      mimeType: normalizedMime,
      dataUrl: await fileToDataUrl(file)
    };
  }

  if (extension === "heic" || extension === "heif" || normalizedMime.includes("heic") || normalizedMime.includes("heif")) {
    const converted = await convertHeicToJpeg(file);
    return {
      mimeType: "image/jpeg",
      dataUrl: await blobToDataUrl(converted)
    };
  }

  const jpegBlob = await convertImageBlobToJpeg(file);
  return {
    mimeType: "image/jpeg",
    dataUrl: await blobToDataUrl(jpegBlob)
  };
}

async function convertHeicToJpeg(file) {
  // CSP-safe path: rely only on browser-native decode paths.
  try {
    return await convertImageBlobToJpeg(file);
  } catch {
    throw new Error(`HEIC conversion is not available in this browser for file: ${file.name}.`);
  }
}

async function convertImageBlobToJpeg(file) {
  try {
    return await convertWithImageDecoder(file);
  } catch {
    // try next strategy
  }

  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas is not available.");
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvasToJpegBlob(canvas);
    return blob;
  } catch {
    // try next strategy
  }

  try {
    return await convertWithHtmlImage(file);
  } catch {
    throw new Error(`Unsupported image format: ${file.name}. Please use PNG/JPEG/GIF/WEBP or HEIC.`);
  }
}

async function convertWithImageDecoder(file) {
  if (typeof window.ImageDecoder !== "function") {
    throw new Error("ImageDecoder is unavailable.");
  }
  const type = (file.type || "").toLowerCase();
  const isSupported = await window.ImageDecoder.isTypeSupported(type || "image/heic");
  if (!isSupported) {
    throw new Error("HEIC type is unsupported by ImageDecoder.");
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const decoder = new window.ImageDecoder({ data, type: type || "image/heic" });
  const { image } = await decoder.decode({ frameIndex: 0 });

  const canvas = document.createElement("canvas");
  canvas.width = image.displayWidth || image.codedWidth;
  canvas.height = image.displayHeight || image.codedHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    image.close();
    throw new Error("Canvas is not available.");
  }
  ctx.drawImage(image, 0, 0);
  image.close();
  decoder.close();
  return canvasToJpegBlob(canvas);
}

function convertWithHtmlImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Canvas is not available.");
        }
        ctx.drawImage(img, 0, 0);
        const blob = await canvasToJpegBlob(canvas);
        URL.revokeObjectURL(url);
        resolve(blob);
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image decode failed."));
    };
    img.src = url;
  });
}

function canvasToJpegBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Image conversion failed."));
        }
      },
      "image/jpeg",
      0.92
    );
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Invalid blob content."));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("Read failed."));
    reader.readAsDataURL(blob);
  });
}

function isTextFile(file, extension) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("text/")) return true;
  if (type.includes("json") || type.includes("xml") || type.includes("yaml") || type.includes("javascript")) {
    return true;
  }
  return TEXT_EXTENSIONS.has(extension);
}

function isPdfFile(file, extension) {
  const type = (file.type || "").toLowerCase();
  return type === "application/pdf" || extension === "pdf";
}

async function extractPdfText(file) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== "function") return null;

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf = await loadingTask.promise;

  const pageLimit = Math.min(pdf.numPages || 0, MAX_PDF_PAGES);
  const pages = [];
  let wasTruncated = (pdf.numPages || 0) > pageLimit;

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = (textContent.items || [])
      .map((item) => (typeof item.str === "string" ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) {
      pages.push(`Page ${pageNumber}:\n${text}`);
    }
  }

  const fullText = pages.join("\n\n");
  if (fullText.length > MAX_PDF_TEXT_CHARS) {
    wasTruncated = true;
  }

  return {
    text: fullText.slice(0, MAX_PDF_TEXT_CHARS),
    wasTruncated
  };
}

function getExtension(name) {
  const safeName = String(name || "").toLowerCase();
  const index = safeName.lastIndexOf(".");
  if (index < 0) return "";
  return safeName.slice(index + 1);
}

function buildBinaryAttachment(file) {
  const extension = getExtension(file.name);
  return {
    id: crypto.randomUUID(),
    name: file.name || "file",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind: "binary",
    badgeLabel: formatBadgeLabel(extension, "file")
  };
}

function formatBadgeLabel(extension, fallback) {
  const ext = String(extension || "").trim().toUpperCase();
  if (ext.length === 0) return fallback.toUpperCase();
  return ext.slice(0, 5);
}

function renderAttachmentPreviews() {
  attachmentPreviewList.innerHTML = "";
  if (pendingAttachments.length === 0) {
    attachmentPreviewList.classList.add("hidden");
    return;
  }
  attachmentPreviewList.classList.remove("hidden");

  pendingAttachments.forEach((item) => {
    const card = document.createElement("div");
    card.className = "attachment-preview-card";

    const top = document.createElement("div");
    top.className = "attachment-preview-top";

    if (item.kind === "image" && item.dataUrl) {
      const img = document.createElement("img");
      img.className = "attachment-preview-thumb";
      img.src = item.dataUrl;
      img.alt = item.name;
      top.appendChild(img);
    } else {
      const badge = document.createElement("span");
      badge.className = "attachment-preview-badge";
      badge.textContent = item.kind === "text" ? "TXT" : (item.badgeLabel || "BIN");
      top.appendChild(badge);
    }

    const name = document.createElement("div");
    name.className = "attachment-preview-name";
    name.textContent = item.name;
    top.appendChild(name);
    card.appendChild(top);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "attachment-preview-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      pendingAttachments = pendingAttachments.filter((entry) => entry.id !== item.id);
      renderAttachmentPreviews();
    });

    card.appendChild(removeBtn);
    attachmentPreviewList.appendChild(card);
  });
}

function renderAll() {
  chatEl.innerHTML = "";
  messages.forEach((message) => renderMessage(message));
  scrollToBottom();
}

function renderMessage(message) {
  const bubble = document.createElement("div");
  bubble.className = `message ${message.role}`;
  bubble.dataset.id = message.id;

  const liveAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  const imageAttachments = liveAttachments.filter((file) => file.kind === "image" && file.dataUrl);
  const fileAttachments = liveAttachments.filter((file) => file.kind !== "image");

  if (message.role === "user" && imageAttachments.length > 0) {
    const gallery = document.createElement("div");
    gallery.className = "message-image-gallery";
    imageAttachments.forEach((file, index) => {
      const img = document.createElement("img");
      img.className = "message-image";
      img.src = file.dataUrl;
      img.alt = `Uploaded image ${index + 1}`;
      gallery.appendChild(img);
    });
    bubble.appendChild(gallery);
  }

  if (message.role === "user" && fileAttachments.length > 0) {
    const filesList = document.createElement("div");
    filesList.className = "message-file-list";
    fileAttachments.forEach((file) => {
      const line = document.createElement("div");
      line.className = "message-file-item";
      if (file.kind === "text") {
        line.textContent = `Text file: ${file.name}`;
      } else if (file.conversionRequired) {
        line.textContent = `File: ${file.name} (convert to JPG/PNG for image solving)`;
      } else {
        line.textContent = `File: ${file.name}`;
      }
      filesList.appendChild(line);
    });
    bubble.appendChild(filesList);
  }

  const summary = message.attachmentSummary || (
    Number(message.imageCount) > 0
      ? { total: Number(message.imageCount), names: [] }
      : null
  );
  if (message.role === "user" && liveAttachments.length === 0 && summary && Number(summary.total) > 0) {
    const note = document.createElement("div");
    note.className = "message-image-note";
    const names = Array.isArray(summary.names) ? summary.names.join(", ") : "";
    note.textContent = names.length > 0 ? `Attached files: ${names}` : `Attached files: ${summary.total}`;
    bubble.appendChild(note);
  }

  const isThinking = isAssistantThinkingMessage(message);
  if (isThinking) {
    const content = document.createElement("div");
    content.className = "content";
    content.appendChild(createThinkingIndicator());
    bubble.appendChild(content);
  } else if (message.content && message.content.trim().length > 0) {
    const content = document.createElement("div");
    content.className = "content";
    content.appendChild(renderRichContent(message.content));
    bubble.appendChild(content);
  }

  if (message.role === "assistant" && !isThinking) {
    const meta = document.createElement("div");
    meta.className = "meta";
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true"></span><span class="copy-label">copy</span>';
    copyBtn.setAttribute("aria-label", "Copy response");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(message.content);
      copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true"></span><span class="copy-label">copied</span>';
      setTimeout(() => {
        copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true"></span><span class="copy-label">copy</span>';
      }, 1200);
    });
    meta.appendChild(copyBtn);
    bubble.appendChild(meta);
  }

  chatEl.appendChild(bubble);
  renderMathInContainer(bubble);
  scheduleTikzHydration(message.id, bubble);
}

function updateMessage(message) {
  const bubble = chatEl.querySelector(`[data-id="${message.id}"]`);
  if (!bubble) return;
  let content = bubble.querySelector(".content");
  if (!content) {
    content = document.createElement("div");
    content.className = "content";
    bubble.appendChild(content);
  }
  const oldMeta = bubble.querySelector(".meta");
  if (oldMeta) oldMeta.remove();
  content.innerHTML = "";
  const isThinking = isAssistantThinkingMessage(message);
  if (isThinking) {
    content.appendChild(createThinkingIndicator());
  } else {
    content.appendChild(renderRichContent(message.content));
  }

  if (message.role === "assistant" && !isThinking) {
    const meta = document.createElement("div");
    meta.className = "meta";
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true"></span><span class="copy-label">copy</span>';
    copyBtn.setAttribute("aria-label", "Copy response");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(message.content);
      copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true"></span><span class="copy-label">copied</span>';
      setTimeout(() => {
        copyBtn.innerHTML = '<span class="copy-icon" aria-hidden="true"></span><span class="copy-label">copy</span>';
      }, 1200);
    });
    meta.appendChild(copyBtn);
    bubble.appendChild(meta);
  }

  renderMathInContainer(bubble);
  scheduleTikzHydration(message.id, bubble);
}

function isAssistantThinkingMessage(message) {
  return message?.role === "assistant" && String(message?.content || "").trim() === "...";
}

function createThinkingIndicator() {
  const wrap = document.createElement("div");
  wrap.className = "thinking-indicator";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", "Assistant is thinking");
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement("span");
    dot.className = "thinking-dot";
    wrap.appendChild(dot);
  }
  return wrap;
}

function scheduleTikzHydration(messageId, bubble) {
  const content = bubble?.querySelector(".content");
  if (!content) return;
  const key = String(messageId || "");
  const prev = pendingTikzHydrationTimers.get(key);
  if (prev) clearTimeout(prev);

  const timer = setTimeout(async () => {
    pendingTikzHydrationTimers.delete(key);
    const rendererUrl = String(settings?.tikzRendererUrl || "").trim();
    if (!rendererUrl) return;
    await renderExternalTikzInContainer(content, {
      rendererUrl,
      rendererToken: String(settings?.tikzRendererToken || "").trim()
    });
  }, 340);

  pendingTikzHydrationTimers.set(key, timer);
}

function showBanner(text) {
  bannerEl.textContent = text;
  bannerEl.classList.remove("hidden");
}

function hideBanner() {
  bannerEl.textContent = "";
  bannerEl.classList.add("hidden");
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}
