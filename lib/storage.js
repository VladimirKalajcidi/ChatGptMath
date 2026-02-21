const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gpt-4.1-mini",
  temperature: 0.2,
  systemPrompt: ""
};

const STORAGE_KEYS = {
  settings: "settings",
  chat: "chat"
};

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: settings
  });
}

export async function getChat() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.chat);
  return result.chat || { messages: [] };
}

export async function saveChat(chat) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.chat]: chat
  });
}

export async function clearChat() {
  await chrome.storage.local.remove(STORAGE_KEYS.chat);
}
