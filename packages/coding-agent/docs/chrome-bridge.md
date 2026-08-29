# Chrome Bridge (open-claude-in-chrome)

Prometh includes a built-in TCP bridge to a vendored copy of
[open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome).
When activated with `--chrome-bridge` (or `createAgentSession({ chromeBridge: true })`),
the agent can drive any Chromium browser through 26 tools, with no separate
MCP server, no extra process to supervise, and no domain blocklist.

```
Prometh (this repo)
  └─ packages/coding-agent/src/core/chrome-bridge/   ← in-process TCP client
       └─ 127.0.0.1:18765  (NDJSON)
            └─ extensions/open-claude-in-chrome/host/native-host.js
                 └─ chrome.runtime.connectNative  (per browser)
                      └─ Chromium extension (extension/manifest.json)
                           └─ Browser tabs (CDP)
```

## Install

1. **Load the vendored extension** in your Chromium browser of choice
   (Chrome, Brave, Edge, Arc, Opera, Vivaldi):
   - Open `chrome://extensions` (or `brave://extensions` / etc.)
   - Enable **Developer mode**
   - Click **Load unpacked** and select `extensions/open-claude-in-chrome/extension/`
   - Copy the **extension ID** shown under the extension name
2. **Register the native messaging host** for your browser:
   ```bash
   ./extensions/open-claude-in-chrome/install.sh <your-extension-id>
   ```
   Pass one ID per browser you use (e.g. `./install.sh <chrome-id> <brave-id>`).
3. **Restart the browser** (close all windows and reopen — Chromium reads
   native messaging configs on startup).
4. **Launch Prometh with the bridge enabled**:
   ```bash
   ./prometh.sh --chrome-bridge
   ```
   Or in a programmatic session:
   ```ts
   import { createAgentSession } from "@earendil-works/pi-coding-agent";
   const { session } = await createAgentSession({ chromeBridge: true, ... });
   ```
5. Ask the agent anything web-shaped: *"Open Hacker News and summarize the
   top five stories"*, *"Sign in to GitHub and star this repo"*, *"Fill out
   the form at https://example.com and click submit"*.

## Settings

Default port is `18765`, host is `127.0.0.1`. Override in
`~/.prometh/settings.json`:

```json
{
  "chromeBridge": {
    "enabled": true,
    "port": 19000,
    "host": "127.0.0.1",
    "requestTimeoutMs": 30000
  }
}
```

Or via environment variables (handy in CI):

```bash
PROMETH_CHROME_BRIDGE_PORT=19000 prometh --chrome-bridge
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` (when `--chrome-bridge` is set) | Master switch. |
| `port` | `18765` | TCP port the vendored native host listens on. |
| `host` | `127.0.0.1` | TCP host. |
| `autoStart` | `true` | Open the socket on session boot. |
| `requestTimeoutMs` | `30000` | Default per-tool-call timeout. |

## Tools

The bridge exposes 26 tool names, matching the upstream OCIC wire protocol
exactly (so payloads round-trip with zero translation). All are wired into
the agent as `customTools` and become available alongside `ipython` /
`bash` / `edit`:

| Tool | Purpose |
|---|---|
| `tabs_context_mcp` | Get the current MCP tab group context. |
| `tabs_create_mcp` | Create a new tab in the MCP group. |
| `tabs_close_mcp` | Close one or more tabs. |
| `navigate` | Navigate a tab (or go back/forward). |
| `computer` | Mouse, keyboard, screenshot, zoom, scroll, drag, hover. |
| `read_page` | Accessibility tree of the page. |
| `get_page_text` | Plain-text article extraction. |
| `find` | Find elements by natural-language description. |
| `form_input` | Set form values by element ref. |
| `javascript_tool` | Evaluate JS in the page context. |
| `read_console_messages` | Read browser console (filterable). |
| `read_network_requests` | Read network activity. |
| `resize_window` | Resize the browser window. |
| `file_upload` | Upload a local file to a `<input type="file">`. |
| `upload_image` | Upload a captured screenshot to a file input. |
| `gif_creator` | Record browser actions as a GIF (stub in upstream). |
| `shortcuts_list` / `shortcuts_execute` | Stubs in upstream. |
| `switch_browser` | Hand off to another Chromium browser. |
| `debug` / `debug_timings` | Per-tool-call timing and CDP diagnostics. |
| `get_config` / `set_config` | Read/write automation settings (e.g. `humanize`). |
| `set_tab_focus` | Surface a tab (or its window) to the user. |
| `update_plan` | Present a plan to the user for approval. |
| `retranscribe_recording` | Re-run transcription on a failed recording. |

For the authoritative reference, see the vendored source:
[`extensions/open-claude-in-chrome/host/tool-definitions.js`](../extensions/open-claude-in-chrome/host/tool-definitions.js).

## From the IPython kernel

The bridge also exposes three host-request handlers, callable from Python
cells:

```python
# Call any tool by name
result = await rlm.host_request("chrome.bridge.call", {
    "method": "navigate",
    "params": {"url": "https://example.com", "tabId": 1},
})

# Inspect the connection state
status = await rlm.host_request("chrome.bridge.status", {})

# List the available tool names
tools = (await rlm.host_request("chrome.bridge.list", {}))["tools"]
```

## Troubleshooting

### Bridge says `connected=false`

The native host is reachable on `127.0.0.1:<port>` only while a Chromium
browser with the extension loaded is running. If you just installed the
extension, fully quit and reopen the browser. The native host process is
spawned by Chromium on extension start and exits when the browser exits.

### `pkill -f "node.*mcp-server"`

The Prometh bridge does **not** spawn a `mcp-server.js` subprocess — that
file in `extensions/open-claude-in-chrome/host/` is upstream OCIC's MCP
front-end, which the Prometh bridge replaces with an in-process TCP
client. If a stale OCIC MCP server is bound to port 18765 from a previous
install, kill it (and any upstream `wrangler` sidecar) before launching
Prometh with `--chrome-bridge`.

### Port conflict

The OCIC config file `~/.config/open-claude-in-chrome/config.json` can
override the port (`{ "port": 19000 }`). Set the same value in
`~/.prometh/settings.json` under `chromeBridge.port`.

### Tools fail immediately

If the extension service worker is suspended (e.g. the browser hasn't been
focused in a while), open any page to wake it. Check the service worker
console at `chrome://extensions` → "Inspect views: service worker" for
upstream-side errors.

## What is NOT included

The Prometh bridge is a **TCP client**, not a code-mode runtime. The
upstream OCIC `execute_code` sandbox (a Cloudflare Worker started by
`wrangler dev` and bridged through `server-hybrid.js`) is a separate
subprocess that Prometh does not start. If you need code-mode tools, run
the OCIC hybrid server separately and configure Prometh to talk to a
second TCP port (future work). All 26 tools listed above are reachable
through Prometh's bridge today; only the `execute_code`/code-mode surface
is not.

## Attribution and license

The vendored copy at `extensions/open-claude-in-chrome/` is a snapshot of
[noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome),
released under the **PolyForm Noncommercial License 1.0.0**. The original
upstream README is preserved at
`extensions/open-claude-in-chrome/README.upstream.md`; the vendoring
metadata is at `extensions/open-claude-in-chrome/UPSTREAM.md`. Re-sync
instructions are in `UPSTREAM.md`.
