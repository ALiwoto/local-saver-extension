import { CaptureSession } from "./capture.js";
import { getDirectoryHandle } from "./db.js";

const sessions = new Map();
const controllerWindows = new Map();
const targetControllers = new Map();
const NEW_TAB_HOSTS = new Set(["newtab", "new-tab-page"]);
const TAB_NAVIGATION_TIMEOUT_MS = 10000;
const DEBUGGER_ATTACH_RETRY_MS = 50;
const DEBUGGER_ATTACH_TIMEOUT_MS = 3000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function controllerUrl(targetTabId) {
  const url = new URL(chrome.runtime.getURL("popup/popup.html"));
  url.searchParams.set("tabId", String(targetTabId));
  return url.href;
}

function targetFromControllerUrl(rawUrl) {
  if (!rawUrl?.startsWith(chrome.runtime.getURL("popup/popup.html"))) {
    return null;
  }
  const value = new URL(rawUrl).searchParams.get("tabId");
  if (value === null) {
    return null;
  }
  const tabId = Number(value);
  return Number.isInteger(tabId) ? tabId : null;
}

function registerControllerWindow(windowId, targetTabId) {
  if (!Number.isInteger(windowId) || !Number.isInteger(targetTabId)) {
    return;
  }
  controllerWindows.set(windowId, targetTabId);
  targetControllers.set(targetTabId, windowId);
}

async function openController(tab) {
  const targetTabId = targetFromControllerUrl(tab.url) ?? tab.id;
  if (!Number.isInteger(targetTabId)) {
    throw new Error("Chrome did not provide a target tab for the recorder.");
  }

  const expectedUrl = controllerUrl(targetTabId);
  const existingTab = (await chrome.tabs.query({})).find(
    (candidate) => candidate.url === expectedUrl,
  );

  if (existingTab?.windowId !== undefined) {
    registerControllerWindow(existingTab.windowId, targetTabId);
    await chrome.windows.update(existingTab.windowId, { focused: true });
    return;
  }

  const controller = await chrome.windows.create({
    url: expectedUrl,
    type: "popup",
    width: 390,
    height: 490,
    focused: true,
  });
  registerControllerWindow(controller.id, targetTabId);
}

function isChromeNewTab(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "chrome:" && NEW_TAB_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function waitForTabUrl(tabId, expectedUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while preparing the tab for capture.`));
    }, TAB_NAVIGATION_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (
        updatedTabId === tabId
        && (changeInfo.url === expectedUrl || tab.url === expectedUrl)
      ) {
        cleanup();
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.url === expectedUrl) {
        cleanup();
        resolve(tab);
      }
    }).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function prepareTabForCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const currentUrl = tab.pendingUrl ?? tab.url ?? "";

  if (!isChromeNewTab(currentUrl)) {
    return false;
  }

  console.info("[Local Request Saver] Preparing New Tab for capture", { tabId, currentUrl });
  const navigation = waitForTabUrl(tabId, "about:blank");
  try {
    await chrome.tabs.update(tabId, { url: "about:blank" });
    await navigation;
  } catch (error) {
    // The waiting promise owns a tabs.onUpdated listener. Ensure it settles if
    // navigation itself fails before Chrome emits an update.
    await navigation.catch(() => {});
    throw error;
  }
  console.info("[Local Request Saver] New Tab is capture-ready", { tabId, url: "about:blank" });
  return true;
}

async function attachCaptureSession(session, retryRestrictedNavigation) {
  const deadline = Date.now() + DEBUGGER_ATTACH_TIMEOUT_MS;

  for (;;) {
    try {
      await session.start();
      return;
    } catch (error) {
      const message = String(error?.message ?? error);
      const canRetry = retryRestrictedNavigation
        && message.includes("Cannot access a chrome:// URL")
        && Date.now() < deadline;

      if (!canRetry) {
        throw error;
      }
      await delay(DEBUGGER_ATTACH_RETRY_MS);
    }
  }
}

async function setBadge(tabId, recording) {
  try {
    await chrome.action.setBadgeText({ tabId, text: recording ? "REC" : "" });
    if (recording) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62828" });
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!recording && message.includes("No tab with id")) {
      return;
    }
    throw error;
  }
}

async function startCapture(tabId, requestFormat) {
  if (sessions.has(tabId)) {
    return { preparedNewTab: false };
  }

  const directoryHandle = await getDirectoryHandle();
  if (!directoryHandle) {
    throw new Error("Select an output folder first.");
  }

  const permission = await directoryHandle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("Folder permission is required. Re-select the folder in the extension popup.");
  }

  const preparedNewTab = await prepareTabForCapture(tabId);

  const session = new CaptureSession(tabId, directoryHandle, requestFormat);
  sessions.set(tabId, session);

  try {
    await attachCaptureSession(session, preparedNewTab);
    await setBadge(tabId, true);
    console.info("[Local Request Saver] Capture started", { tabId, requestFormat });
    return { preparedNewTab };
  } catch (error) {
    sessions.delete(tabId);
    console.error("[Local Request Saver] Could not start capture", { tabId, error });
    throw error;
  }
}

async function stopCapture(tabId, reason) {
  const session = sessions.get(tabId);
  if (!session) {
    await setBadge(tabId, false);
    console.info("[Local Request Saver] Capture is already stopped", { tabId, reason });
    return;
  }

  sessions.delete(tabId);
  await session.stop(reason);
  await setBadge(tabId, false);
  console.info("[Local Request Saver] Capture stopped", { tabId, reason });
}

chrome.debugger.onEvent.addListener((source, method, parameters) => {
  const session = sessions.get(source.tabId);
  if (!session) {
    return;
  }
  session.handleEvent(source, method, parameters).catch((error) => {
    console.error("Capture event failed", method, error);
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const session = sessions.get(source.tabId);
  if (!session) {
    return;
  }
  sessions.delete(source.tabId);
  session.stop(`Debugger detached: ${reason}`).catch(console.error);
  setBadge(source.tabId, false).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const controllerWindowId = targetControllers.get(tabId);
  targetControllers.delete(tabId);
  if (controllerWindowId !== undefined) {
    controllerWindows.delete(controllerWindowId);
  }

  stopCapture(tabId, "Tab closed")
    .then(() => {
      if (controllerWindowId !== undefined) {
        return chrome.windows.remove(controllerWindowId).catch(() => {});
      }
      return undefined;
    })
    .catch(console.error);
});

chrome.windows.onRemoved.addListener((windowId) => {
  const targetTabId = controllerWindows.get(windowId);
  if (targetTabId === undefined) {
    return;
  }

  controllerWindows.delete(windowId);
  if (targetControllers.get(targetTabId) === windowId) {
    targetControllers.delete(targetTabId);
  }
  stopCapture(targetTabId, "Recorder window closed").catch(console.error);
});

chrome.action.onClicked.addListener((tab) => {
  openController(tab).catch((error) => {
    console.error("[Local Request Saver] Could not open recorder window", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (Number.isInteger(message.tabId) && Number.isInteger(sender.tab?.windowId)) {
    registerControllerWindow(sender.tab.windowId, message.tabId);
  }

  (async () => {
    switch (message.type) {
      case "REGISTER_CONTROLLER":
        return { registered: true };
      case "GET_STATUS":
        return { recording: sessions.has(message.tabId) };
      case "START_CAPTURE":
        return { recording: true, ...(await startCapture(message.tabId, message.requestFormat)) };
      case "STOP_CAPTURE":
        await stopCapture(message.tabId, "Stopped by user");
        return { recording: false };
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  })()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error("[Local Request Saver] Popup action failed", message, error);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });

  return true;
});
