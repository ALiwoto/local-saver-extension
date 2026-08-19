import { ArtifactWriter } from "./filesystem.js";

const PROTOCOL_VERSION = "1.3";
const FINALIZE_DELAY_MS = 100;

function debuggerCommand(target, method, parameters = {}) {
  return chrome.debugger.sendCommand(target, method, parameters);
}

function recordKey(source, requestId) {
  return `${source.sessionId ?? "root"}:${requestId}`;
}

function targetForSource(tabId, source) {
  return source.sessionId ? { tabId, sessionId: source.sessionId } : { tabId };
}

function decodeBody(result) {
  if (result.base64Encoded) {
    const binary = atob(result.body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new TextEncoder().encode(result.body);
}

export class CaptureSession {
  constructor(tabId, directoryHandle, requestFormat) {
    this.tabId = tabId;
    this.writer = new ArtifactWriter(directoryHandle, requestFormat);
    this.records = new Map();
    this.pendingRequestExtra = new Map();
    this.pendingResponseExtra = new Map();
    this.stopped = false;
  }

  get rootTarget() {
    return { tabId: this.tabId };
  }

  async start() {
    await chrome.debugger.attach(this.rootTarget, PROTOCOL_VERSION);
    try {
      await this.enableTarget(this.rootTarget);
    } catch (error) {
      await chrome.debugger.detach(this.rootTarget).catch(() => {});
      throw error;
    }
  }

  async enableTarget(target) {
    await debuggerCommand(target, "Network.enable", {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 25 * 1024 * 1024,
      maxPostDataSize: 10 * 1024 * 1024,
    });

    await debuggerCommand(target, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch((error) => {
      console.debug("Target auto-attach is not available for this target", error);
    });
  }

  async stop(reason = "Stopped by user") {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    for (const record of this.records.values()) {
      clearTimeout(record.finalizeTimer);
      record.failure ??= { errorText: reason, canceled: true };
      this.writer.enqueue(record, record.body ?? null);
    }
    this.records.clear();

    await chrome.debugger.detach(this.rootTarget).catch(() => {});
    await this.writer.flush();
  }

  async handleEvent(source, method, parameters) {
    if (this.stopped) {
      return;
    }

    if (method === "Target.attachedToTarget") {
      const childTarget = { tabId: this.tabId, sessionId: parameters.sessionId };
      await this.enableTarget(childTarget).catch((error) => {
        console.debug("Could not enable capture for child target", parameters.targetInfo, error);
      });
      return;
    }

    const key = parameters.requestId ? recordKey(source, parameters.requestId) : null;

    switch (method) {
      case "Network.requestWillBeSent":
        await this.handleRequest(source, key, parameters);
        break;
      case "Network.requestWillBeSentExtraInfo":
        this.handleRequestExtra(key, parameters);
        break;
      case "Network.responseReceived":
        this.handleResponse(key, parameters);
        break;
      case "Network.responseReceivedExtraInfo":
        this.handleResponseExtra(key, parameters);
        break;
      case "Network.loadingFinished":
        await this.handleFinished(source, key, parameters);
        break;
      case "Network.loadingFailed":
        await this.handleFailed(source, key, parameters);
        break;
      default:
        break;
    }
  }

  async handleRequest(source, key, parameters) {
    const previous = this.records.get(key);
    if (previous && parameters.redirectResponse) {
      clearTimeout(previous.finalizeTimer);
      previous.response = parameters.redirectResponse;
      previous.resourceType = parameters.type;
      this.records.delete(key);
      this.writer.enqueue(previous, null);
    }

    const requestExtra = this.pendingRequestExtra.get(key);
    this.pendingRequestExtra.delete(key);

    const record = {
      key,
      source: targetForSource(this.tabId, source),
      requestId: parameters.requestId,
      request: {
        ...parameters.request,
        headers: {
          ...(parameters.request.headers ?? {}),
          ...(requestExtra?.headers ?? {}),
        },
      },
      requestExtra,
      documentURL: parameters.documentURL,
      initiator: parameters.initiator,
      resourceType: parameters.type,
      wallTime: parameters.wallTime,
    };

    this.records.set(key, record);
  }

  handleRequestExtra(key, parameters) {
    const record = this.records.get(key);
    if (!record) {
      this.pendingRequestExtra.set(key, parameters);
      return;
    }
    record.requestExtra = parameters;
    record.request.headers = {
      ...(record.request.headers ?? {}),
      ...(parameters.headers ?? {}),
    };
  }

  handleResponse(key, parameters) {
    const record = this.records.get(key);
    if (!record) {
      return;
    }
    record.response = parameters.response;
    record.resourceType = parameters.type;

    const pendingExtra = this.pendingResponseExtra.get(key);
    if (pendingExtra) {
      record.responseExtra = pendingExtra;
      this.pendingResponseExtra.delete(key);
    }
  }

  handleResponseExtra(key, parameters) {
    const record = this.records.get(key);
    if (!record) {
      this.pendingResponseExtra.set(key, parameters);
      return;
    }
    record.responseExtra = parameters;
  }

  async populatePostData(record) {
    if (typeof record.request.postData === "string" || !record.request.hasPostData) {
      return;
    }
    try {
      const result = await debuggerCommand(record.source, "Network.getRequestPostData", {
        requestId: record.requestId,
      });
      record.request.postData = result.postData;
    } catch (error) {
      record.postDataError = String(error?.message ?? error);
    }
  }

  async handleFinished(source, key, parameters) {
    const record = this.records.get(key);
    if (!record || record.finalizing) {
      return;
    }
    record.finalizing = true;
    record.encodedDataLength = parameters.encodedDataLength;

    await this.populatePostData(record);

    try {
      const result = await debuggerCommand(targetForSource(this.tabId, source), "Network.getResponseBody", {
        requestId: parameters.requestId,
      });
      record.body = decodeBody(result);
    } catch (error) {
      record.body = null;
      record.bodyError = String(error?.message ?? error);
    }

    record.finalizeTimer = setTimeout(() => this.finalize(key, record), FINALIZE_DELAY_MS);
  }

  async handleFailed(_source, key, parameters) {
    const record = this.records.get(key);
    if (!record || record.finalizing) {
      return;
    }
    record.finalizing = true;
    record.failure = {
      errorText: parameters.errorText,
      canceled: parameters.canceled ?? false,
      blockedReason: parameters.blockedReason ?? null,
      corsErrorStatus: parameters.corsErrorStatus ?? null,
    };
    await this.populatePostData(record);
    record.finalizeTimer = setTimeout(() => this.finalize(key, record), FINALIZE_DELAY_MS);
  }

  finalize(key, record) {
    if (this.records.get(key) !== record) {
      return;
    }
    this.records.delete(key);
    this.writer.enqueue(record, record.body ?? null);
  }
}
