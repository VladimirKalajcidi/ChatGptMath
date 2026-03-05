const SIDE_PANEL_PATH = "sidepanel/sidepanel.html";
const WELCOME_PAGE_URL = "https://vladimirkalajcidi.github.io/metadata-viewer-welcome_page/chatgptmath.html";

function hasSidePanel() {
  return typeof chrome.sidePanel !== "undefined";
}

async function openSidePanel(tabId) {
  if (hasSidePanel()) {
    try {
      await chrome.sidePanel.setOptions({
        tabId,
        path: SIDE_PANEL_PATH,
        enabled: true
      });
      await chrome.sidePanel.open({ tabId });
      return;
    } catch (error) {
      console.warn("Failed to open side panel, falling back to popup.", error);
    }
  }

  chrome.windows.create({
    url: SIDE_PANEL_PATH,
    type: "popup",
    width: 420,
    height: 720
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (hasSidePanel()) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({
      url: WELCOME_PAGE_URL
    });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  if (tabId) {
    await openSidePanel(tabId);
  } else {
    chrome.windows.create({
      url: SIDE_PANEL_PATH,
      type: "popup",
      width: 420,
      height: 720
    });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-sidebar") return;
  const tabId = tab?.id;
  if (tabId) {
    await openSidePanel(tabId);
  } else {
    chrome.windows.create({
      url: SIDE_PANEL_PATH,
      type: "popup",
      width: 420,
      height: 720
    });
  }
});
