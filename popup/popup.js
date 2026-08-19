import { getDirectoryHandle, setDirectoryHandle } from "../src/db.js";

const folderName = document.querySelector("#folder-name");
const selectFolderButton = document.querySelector("#select-folder");
const requestFormat = document.querySelector("#request-format");
const toggleButton = document.querySelector("#toggle");
const stateBadge = document.querySelector("#state");
const message = document.querySelector("#message");

let tabId = null;
let directoryHandle = null;
let recording = false;

function showMessage(text = "", type = "error") {
  message.textContent = text;
  message.className = text ? type : "";
}

function render() {
  folderName.textContent = directoryHandle?.name ?? "No folder selected";
  folderName.title = directoryHandle?.name ?? "No folder selected";
  toggleButton.disabled = tabId === null || (!directoryHandle && !recording);
  toggleButton.textContent = recording ? "Stop recording" : "Start recording this tab";
  toggleButton.classList.toggle("recording", recording);
  stateBadge.textContent = recording ? "Recording" : "Idle";
  stateBadge.className = `state ${recording ? "recording" : "idle"}`;
  selectFolderButton.disabled = recording;
  requestFormat.disabled = recording;
}

async function ensureWritePermission(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }
  return (await handle.requestPermission(options)) === "granted";
}

async function chooseFolder() {
  showMessage();
  if (!("showDirectoryPicker" in window)) {
    throw new Error("This Chrome version does not expose the folder picker to extensions.");
  }

  const handle = await window.showDirectoryPicker({
    id: "local-request-saver-output",
    mode: "readwrite",
  });

  if (!(await ensureWritePermission(handle))) {
    throw new Error("Write permission was not granted for this folder.");
  }

  await setDirectoryHandle(handle);
  directoryHandle = handle;
  render();
}

async function toggleCapture() {
  showMessage();
  toggleButton.disabled = true;

  try {
    if (!recording && !(await ensureWritePermission(directoryHandle))) {
      throw new Error("Write permission was not granted for the selected folder.");
    }

    await chrome.storage.local.set({ requestFormat: requestFormat.value });
    const response = await chrome.runtime.sendMessage({
      type: recording ? "STOP_CAPTURE" : "START_CAPTURE",
      tabId,
      requestFormat: requestFormat.value,
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "The background worker did not respond.");
    }
    recording = response.recording;
    if (response.preparedNewTab) {
      showMessage("Recording is active. Enter the destination URL in the address bar.", "info");
    }
  } catch (error) {
    showMessage(error?.message ?? String(error));
  } finally {
    render();
  }
}

selectFolderButton.addEventListener("click", () => {
  chooseFolder().catch((error) => {
    if (error?.name !== "AbortError") {
      showMessage(error?.message ?? String(error));
    }
  });
});

toggleButton.addEventListener("click", toggleCapture);

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  directoryHandle = await getDirectoryHandle();

  const settings = await chrome.storage.local.get({ requestFormat: "bash" });
  requestFormat.value = settings.requestFormat;

  if (tabId !== null) {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS", tabId });
    recording = response?.ok && response.recording;
  }
  render();
}

initialize().catch((error) => {
  showMessage(error?.message ?? String(error));
  render();
});
