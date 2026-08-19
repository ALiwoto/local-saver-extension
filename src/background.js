import { CaptureSession } from "./capture.js";
import { getDirectoryHandle } from "./db.js";

const sessions = new Map();
const NEW_TAB_HOSTS = new Set(["newtab", "new-tab-page"]);
const TAB_NAVIGATION_TIMEOUT_MS = 10000;
const DEBUGGER_ATTACH_RETRY_MS = 50;
const DEBUGGER_ATTACH_TIMEOUT_MS = 3000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  await chrome.action.setBadgeText({ tabId, text: recording ? "REC" : "" });
  if (recording) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62828" });
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
  stopCapture(tabId, "Tab closed").catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
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
