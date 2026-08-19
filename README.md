# Local Request Saver

A developer-oriented Chrome Manifest V3 extension that records network traffic from the current tab into a user-selected local directory.

For each request, it writes:

- `path/to/resource.req`: a reproducible cURL command in bash, cmd, or PowerShell syntax.
- `path/to/resource.resp`: response status, headers, timing, cache, security, and failure metadata as JSON.
- `path/to/resource`: the response body, when Chrome makes one available.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this repository.
4. Pin **Local Request Saver** to the toolbar.

## Use

1. Open the tab whose traffic you want to record.
2. Select the extension toolbar button. A small recorder window opens for the current tab.
3. Keep the recorder window open and choose an output folder.
4. Choose the request command format.
5. Select **Start recording this tab**.
6. Reload or use the page.
7. Return to the recorder window and select **Stop recording**.

To capture a navigation from its very first request, start from Chrome's New Tab page. When recording starts, the extension changes that restricted page to `about:blank`, attaches the debugger, returns focus to that tab, and then waits for you to enter the destination URL in the address bar.

The recorder is a persistent window instead of a toolbar dropdown because Chrome keeps File System Access permission active only while an extension page for that origin remains open. Closing the recorder window stops capture.

Stopping is idempotent: it remains safe to select **Stop recording** after the target tab has already been closed.

Chrome displays its debugger warning while a tab is being recorded. Closing that warning detaches the extension and stops capture.

## Output paths

The request URL determines the path below the selected folder. For example:

```text
https://example.com/ui/something.json
```

produces:

```text
example.com/ui/something.json.req
example.com/ui/something.json.resp
example.com/ui/something.json
```

Query strings receive a stable hash suffix. Repeated requests receive `__2`, `__3`, and subsequent suffixes so existing captures are never overwritten.

## Current limitations

- Request and response headers can contain credentials, cookies, and tokens. Captures should be treated as sensitive.
- Chrome may not expose bodies for some cached, failed, streamed, WebSocket, or browser-internal requests.
- Multipart request bodies do not include the contents of uploaded files.
- The saved body is the representation returned by the DevTools Protocol, not necessarily the original compressed wire bytes.
- Opening DevTools on the recorded tab can detach the extension debugger.

## Diagnostics

1. Open `chrome://extensions` and find **Local Request Saver**.
2. Select the **service worker** link under **Inspect views**.
3. Keep the Console open and reproduce the problem.
4. Copy the messages beginning with `[Local Request Saver]`, plus any red errors.

Write failures include the request URL and intended relative output path in the service worker console.
