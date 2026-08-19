import { CaptureSession } from "./capture.js";
import { getDirectoryHandle } from "./db.js";

const sessions = new Map();

async function setBadge(tabId, recording) {
  await chrome.action.setBadgeText({ tabId, text: recording ? "REC" : "" });
  if (recording) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62828" });
  }
}

async function startCapture(tabId, requestFormat) {
  if (sessions.has(tabId)) {
    return;
  }

  const directoryHandle = await getDirectoryHandle();
  if (!directoryHandle) {
    throw new Error("Select an output folder first.");
  }

  const permission = await directoryHandle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("Folder permission is required. Re-select the folder in the extension popup.");
  }

  const session = new CaptureSession(tabId, directoryHandle, requestFormat);
  sessions.set(tabId, session);

  try {
    await session.start();
    await setBadge(tabId, true);
  } catch (error) {
    sessions.delete(tabId);
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
        await startCapture(message.tabId, message.requestFormat);
        return { recording: true };
      case "STOP_CAPTURE":
        await stopCapture(message.tabId, "Stopped by user");
        return { recording: false };
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  })()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));

  return true;
});
