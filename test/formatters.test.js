import assert from "node:assert/strict";
import test from "node:test";

import { formatRequest } from "../src/formatters.js";

const request = {
  method: "POST",
  url: "https://example.com/api?q=one&other=two",
  headers: {
    accept: "application/json",
    "x-description": "it's a test",
  },
  postData: '{"path":"C:\\\\temp\\\\file.txt"}',
};

test("bash output quotes apostrophes and includes the request body", () => {
  const output = formatRequest(request, "bash");

  assert.match(output, /^curl \\\n/);
  assert.match(output, /--request 'POST'/);
  assert.match(output, /--header 'x-description: it'\\''s a test'/);
  assert.match(output, /--data-raw '\{"path":/);
});

test("cmd output applies Windows argv quoting", () => {
  const output = formatRequest(request, "cmd");

  assert.match(output, /^curl\.exe \^\r\n/);
  assert.match(output, /--url "https:\/\/example\.com\/api\?q=one&other=two"/);
  assert.match(output, /--data-raw "\{\\"path\\":/);
});

test("PowerShell output uses single-quoted curl.exe arguments", () => {
  const output = formatRequest(request, "powershell");

  assert.match(output, /^curl\.exe `\r\n/);
  assert.match(output, /--header 'x-description: it''s a test'/);
  assert.match(output, /--data-raw '\{"path":/);
});
