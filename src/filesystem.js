import { formatRequest } from "./formatters.js";

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_SEGMENT_LENGTH = 140;

function hashString(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sanitizeSegment(value, fallback = "unnamed") {
  let result = String(value)
    .replace(INVALID_FILENAME_CHARACTERS, "_")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!result) {
    result = fallback;
  }
  if (WINDOWS_RESERVED_NAMES.test(result)) {
    result = `_${result}`;
  }
  if (result.length > MAX_SEGMENT_LENGTH) {
    result = `${result.slice(0, MAX_SEGMENT_LENGTH - 11)}__${hashString(result)}`;
  }
  return result;
}

function addSuffix(filename, suffix) {
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return `${filename}${suffix}`;
  }
  return `${filename.slice(0, extensionIndex)}${suffix}${filename.slice(extensionIndex)}`;
}

function pathForUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      directories: ["_invalid_url"],
      filename: `request__${hashString(rawUrl)}`,
    };
  }

  const protocol = url.protocol.replace(/:$/, "") || "unknown";
  const host = url.hostname
    ? `${url.hostname}${url.port ? `_port_${url.port}` : ""}`
    : `_scheme_${protocol}`;
  const pathSegments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  let filename = pathSegments.pop() || "index";

  if (url.search) {
    filename = addSuffix(filename, `__q_${hashString(url.search)}`);
  }

  return {
    directories: [sanitizeSegment(host), ...pathSegments.map((part) => sanitizeSegment(part))],
    filename: sanitizeSegment(filename),
  };
}

async function getDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function fileExists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error?.name === "NotFoundError") {
      return false;
    }
    throw error;
  }
}

async function chooseFilename(directory, requestedName) {
  for (let occurrence = 1; ; occurrence += 1) {
    const suffix = occurrence === 1 ? "" : `__${occurrence}`;
    const candidate = addSuffix(requestedName, suffix);
    const names = [candidate, `${candidate}.req`, `${candidate}.resp`];

    if (!(await Promise.all(names.map((name) => fileExists(directory, name)))).some(Boolean)) {
      return candidate;
    }
  }
}

async function writeFile(directory, name, contents) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

function responseMetadata(record, bodySaved) {
  const response = record.response ?? {};
  const extra = record.responseExtra ?? {};

  return {
    capturedAt: new Date().toISOString(),
    requestId: record.requestId,
    url: response.url ?? record.request.url,
    status: extra.statusCode ?? response.status ?? null,
    statusText: response.statusText ?? null,
    protocol: response.protocol ?? null,
    mimeType: response.mimeType ?? null,
    headers: {
      ...(response.headers ?? {}),
      ...(extra.headers ?? {}),
    },
    headersText: extra.headersText ?? null,
    remoteIPAddress: response.remoteIPAddress ?? null,
    remotePort: response.remotePort ?? null,
    fromDiskCache: response.fromDiskCache ?? false,
    fromServiceWorker: response.fromServiceWorker ?? false,
    fromPrefetchCache: response.fromPrefetchCache ?? false,
    encodedDataLength: record.encodedDataLength ?? null,
    timing: response.timing ?? null,
    securityDetails: response.securityDetails ?? null,
    resourceType: record.resourceType ?? null,
    failed: record.failure ?? null,
    bodyError: record.bodyError ?? null,
    postDataError: record.postDataError ?? null,
    bodySaved,
  };
}

export class ArtifactWriter {
  constructor(directoryHandle, requestFormat) {
    this.directoryHandle = directoryHandle;
    this.requestFormat = requestFormat;
    this.writeChain = Promise.resolve();
  }

  enqueue(record, body) {
    const operation = this.writeChain.then(() => this.write(record, body));
    this.writeChain = operation.catch((error) => {
      console.error("Failed to write captured request", record.request?.url, error);
    });
    return operation;
  }

  async write(record, body) {
    const path = pathForUrl(record.request.url);
    const directory = await getDirectory(this.directoryHandle, path.directories);
    const filename = await chooseFilename(directory, path.filename);
    const relativePath = [...path.directories, filename].join("/");
    const requestText = formatRequest(record.request, this.requestFormat);
    const metadataText = `${JSON.stringify(responseMetadata(record, body !== null), null, 2)}\n`;

    console.info("[Local Request Saver] Writing capture", {
      url: record.request.url,
      relativePath,
      bodyAvailable: body !== null,
    });
    await writeFile(directory, `${filename}.req`, requestText);
    await writeFile(directory, `${filename}.resp`, metadataText);
    if (body !== null) {
      await writeFile(directory, filename, body);
    }
    console.info("[Local Request Saver] Capture written", { relativePath });
  }

  flush() {
    return this.writeChain;
  }
}
