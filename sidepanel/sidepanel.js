import { getSettings, getChat, saveChat, clearChat } from "../lib/storage.js";
import { createChatCompletion } from "../lib/openai.js";
import { renderMathInContainer, renderRichContent } from "../lib/render.js";

const chatEl = document.getElementById("chat");
const composer = document.getElementById("composer-input");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop-stream");
const newChatBtn = document.getElementById("new-chat");
const clearBtn = document.getElementById("clear-chat");
const settingsBtn = document.getElementById("open-settings");
const bannerEl = document.getElementById("banner");

let settings = null;
let messages = [];
let activeController = null;

init();

async function init() {
  settings = await getSettings();
  const chat = await getChat();
  messages = chat.messages || [];
  renderAll();
  setupEvents();
}

function setupEvents() {
  sendBtn.addEventListener("click", handleSend);
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });
  stopBtn.addEventListener("click", () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
      stopBtn.classList.add("hidden");
    }
  });
  newChatBtn.addEventListener("click", async () => {
    messages = [];
    await saveChat({ messages });
    renderAll();
  });
  clearBtn.addEventListener("click", async () => {
    messages = [];
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
  const content = composer.value.trim();
  if (!content) return;

  settings = await getSettings();
  if (!settings.apiKey) {
    showBanner("Set API key in Settings to start chatting.");
    return;
  }

  hideBanner();
  composer.value = "";

  const userMessage = createMessage("user", content);
  messages.push(userMessage);
  await saveChat({ messages });
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

    assistantMessage.content = reply;
  } catch (error) {
    if (error.name === "AbortError") {
      assistantMessage.content = "Request cancelled.";
    } else {
      assistantMessage.content = error.message || "Something went wrong.";
    }
  } finally {
    activeController = null;
    stopBtn.classList.add("hidden");
    await saveChat({ messages });
    updateMessage(assistantMessage);
    scrollToBottom();
  }
}

function createMessage(role, content) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
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

  const content = document.createElement("div");
  content.className = "content";
  content.appendChild(renderRichContent(message.content));
  bubble.appendChild(content);

  if (message.role === "assistant") {
    const meta = document.createElement("div");
    meta.className = "meta";
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(message.content);
      copyBtn.textContent = "Copied";
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 1200);
    });
    meta.appendChild(copyBtn);
    bubble.appendChild(meta);
  }

  chatEl.appendChild(bubble);
  renderMathInContainer(bubble);
}

function updateMessage(message) {
  const bubble = chatEl.querySelector(`[data-id="${message.id}"]`);
  if (!bubble) return;
  const content = bubble.querySelector(".content");
  if (!content) return;
  content.innerHTML = "";
  content.appendChild(renderRichContent(message.content));
  renderMathInContainer(bubble);
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
