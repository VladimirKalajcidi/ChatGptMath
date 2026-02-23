import { getSettings, saveSettings } from "../lib/storage.js";

const apiKeyInput = document.getElementById("api-key");
const modelSelect = document.getElementById("model");
const temperatureInput = document.getElementById("temperature");
const temperatureValue = document.getElementById("temperature-value");
const systemPromptInput = document.getElementById("system-prompt");
const tikzRendererUrlInput = document.getElementById("tikz-renderer-url");
const tikzRendererTokenInput = document.getElementById("tikz-renderer-token");
const statusEl = document.getElementById("status");
const form = document.getElementById("settings-form");

init();

async function init() {
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey || "";
  modelSelect.value = settings.model || "gpt-4.1-mini";
  temperatureInput.value = settings.temperature ?? 0.2;
  temperatureValue.textContent = String(settings.temperature ?? 0.2);
  systemPromptInput.value = settings.systemPrompt || "";
  tikzRendererUrlInput.value = settings.tikzRendererUrl || "";
  tikzRendererTokenInput.value = settings.tikzRendererToken || "";
}

temperatureInput.addEventListener("input", () => {
  temperatureValue.textContent = temperatureInput.value;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {
    apiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
    temperature: Number(temperatureInput.value),
    systemPrompt: systemPromptInput.value,
    tikzRendererUrl: tikzRendererUrlInput.value.trim(),
    tikzRendererToken: tikzRendererTokenInput.value.trim()
  };
  await saveSettings(settings);
  statusEl.textContent = "Saved.";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 1500);
});
