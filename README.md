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
2. Open the extension popup and choose an output folder.
3. Choose the request command format.
4. Select **Start recording this tab**.
5. Reload or use the page.
6. Open the popup again and select **Stop recording**.

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
