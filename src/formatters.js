function headerEntries(headers = {}) {
  return Object.entries(headers)
    .filter(([name]) => !name.startsWith(":"))
    .map(([name, value]) => [name, String(value)]);
}

function bashQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function cmdQuote(value) {
  let result = '"';
  let backslashes = 0;

  for (const character of String(value)) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }

    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
    } else {
      result += "\\".repeat(backslashes);
      result += character;
    }
    backslashes = 0;
  }

  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requestParts(request) {
  const parts = [];

  if (request.method && request.method !== "GET") {
    parts.push(["--request", request.method]);
  }

  parts.push(["--url", request.url]);

  for (const [name, value] of headerEntries(request.headers)) {
    parts.push(["--header", `${name}: ${value}`]);
  }

  if (typeof request.postData === "string") {
    parts.push(["--data-raw", request.postData]);
  }

  return parts;
}

function formatBash(request) {
  const lines = ["curl"];
  for (const [flag, value] of requestParts(request)) {
    lines.push(`  ${flag} ${bashQuote(value)}`);
  }
  return `${lines.join(" \\\n")}\n`;
}

function formatCmd(request) {
  const lines = ["curl.exe"];
  for (const [flag, value] of requestParts(request)) {
    lines.push(`  ${flag} ${cmdQuote(value)}`);
  }
  return `${lines.join(" ^\r\n")}\r\n`;
}

function formatPowerShell(request) {
  const lines = ["curl.exe"];
  for (const [flag, value] of requestParts(request)) {
    lines.push(`  ${flag} ${powershellQuote(value)}`);
  }
  return `${lines.join(" `\r\n")}\r\n`;
}

export function formatRequest(request, format) {
  switch (format) {
    case "cmd":
      return formatCmd(request);
    case "powershell":
      return formatPowerShell(request);
    case "bash":
    default:
      return formatBash(request);
  }
}
