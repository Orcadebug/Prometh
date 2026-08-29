import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../extensions/types.js";
import type { ChromeBridgeClient } from "./chrome-bridge-client.js";

/**
 * Convert the result of an upstream tool call into the
 * `AgentToolResult` shape the agent loop consumes. Most upstream tool
 * results are JSON-serializable; screenshot/zoom results include a
 * `dataUrl` (base64-encoded image) that we surface as an `ImageContent`
 * block so the model can see the page.
 */
function toolResultToAgentResult(raw: unknown): AgentToolResult<unknown> {
	const content: (TextContent | ImageContent)[] = [];
	if (raw == null) {
		content.push({ type: "text", text: "(no result)" });
	} else if (typeof raw === "string") {
		content.push({ type: "text", text: raw });
	} else if (typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		// Upstream screenshot results carry a base64 dataUrl.
		if (typeof obj.dataUrl === "string" && obj.dataUrl.startsWith("data:")) {
			const match = obj.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
			if (match) {
				const mimeType = match[1] || "image/png";
				const data = match[2] || "";
				content.push({ type: "image", data, mimeType });
				if (obj.text) content.push({ type: "text", text: String(obj.text) });
			} else {
				content.push({ type: "text", text: JSON.stringify(obj, null, 2) });
			}
		} else {
			content.push({ type: "text", text: JSON.stringify(obj, null, 2) });
		}
	} else {
		content.push({ type: "text", text: String(raw) });
	}
	return { content, details: raw };
}

/**
 * Build the executor that the chrome-bridge tools all share. Passes the
 * validated `params` through to the bridge, which forwards them to the
 * extension on the Chromium side.
 */
function makeExecutor(client: ChromeBridgeClient, toolName: string): ToolDefinition["execute"] {
	return async (_id, params, signal) => {
		const wireParams = (params ?? {}) as Record<string, unknown>;
		const result = await client.request({ tool: toolName, args: wireParams }, { signal });
		return toolResultToAgentResult(result);
	};
}

/**
 * Returns the 26 vendored open-claude-in-chrome tool definitions, wrapped
 * in the Prometh `ToolDefinition` shape. Each tool's `name` and `type`
 * field match the upstream wire protocol exactly so payloads round-trip
 * with zero translation.
 */
export function createChromeBridgeToolDefinitions(client: ChromeBridgeClient): ToolDefinition[] {
	const defs: ToolDefinition[] = [];

	const add = <S extends Parameters<typeof Type.Object>[0]>(
		name: string,
		label: string,
		description: string,
		parameters: S,
	): void => {
		defs.push({
			name,
			label,
			description,
			parameters: Type.Object(parameters),
			execute: makeExecutor(client, name),
		});
	};

	add(
		"tabs_context_mcp",
		"Browser tabs context",
		"Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.",
		{
			createIfEmpty: Type.Optional(Type.Boolean({ description: "Creates a new MCP tab group if none exists." })),
		},
	);

	add(
		"tabs_create_mcp",
		"Browser create tab",
		"Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist.",
		{},
	);

	add(
		"tabs_close_mcp",
		"Browser close tab",
		"Close one or more tabs in the MCP tab group. The tab is actually removed from the browser — this is the only correct way to close a tab. Only tabs in the current MCP group can be closed; requests for tabs outside the group are skipped. If you close the last remaining tab, the MCP group window closes and you'll need tabs_context_mcp({ createIfEmpty: true }) to start a new group.",
		{
			tabId: Type.Optional(Type.Number({ description: "Single tab ID to close." })),
			tabIds: Type.Optional(
				Type.Array(Type.Number(), {
					description: "Optional batch form: an array of tab IDs to close in one call.",
				}),
			),
		},
	);

	add(
		"navigate",
		"Browser navigate",
		"Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
		{
			url: Type.String({ description: 'The URL to navigate to, or "forward" / "back".' }),
			tabId: Type.Number({ description: "Tab ID to navigate. Must be a tab in the current group." }),
		},
	);

	add(
		"computer",
		"Browser computer use",
		"Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
		{
			action: Type.Union([
				Type.Literal("left_click"),
				Type.Literal("right_click"),
				Type.Literal("double_click"),
				Type.Literal("triple_click"),
				Type.Literal("type"),
				Type.Literal("screenshot"),
				Type.Literal("wait"),
				Type.Literal("scroll"),
				Type.Literal("key"),
				Type.Literal("left_click_drag"),
				Type.Literal("zoom"),
				Type.Literal("scroll_to"),
				Type.Literal("hover"),
			]),
			tabId: Type.Number({ description: "Tab ID to execute the action on." }),
			coordinate: Type.Optional(Type.Array(Type.Number(), { description: "(x, y) coordinate." })),
			duration: Type.Optional(Type.Number({ description: "Seconds to wait (for `wait` action)." })),
			modifiers: Type.Optional(Type.String({ description: 'Modifier keys, e.g. "ctrl+shift".' })),
			ref: Type.Optional(Type.String({ description: "Element reference ID from read_page or find." })),
			region: Type.Optional(Type.Array(Type.Number(), { description: "(x0, y0, x1, y1) for `zoom`." })),
			repeat: Type.Optional(Type.Number({ description: "Repeat count for `key` action." })),
			scroll_direction: Type.Optional(
				Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
			),
			scroll_amount: Type.Optional(Type.Number({ description: "Scroll wheel ticks for `scroll`." })),
			start_coordinate: Type.Optional(
				Type.Array(Type.Number(), { description: "(x, y) start for `left_click_drag`." }),
			),
			text: Type.Optional(Type.String({ description: "Text to type, or keys to press." })),
			save_to_disk: Type.Optional(
				Type.Boolean({ description: "Write the screenshot to disk and return its absolute path." }),
			),
		},
	);

	add(
		"find",
		"Browser find",
		"Find elements on the page using natural language. Returns up to 20 matching elements with references that can be used with other tools. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
		{
			query: Type.String({ description: "Natural language description of what to find." }),
			tabId: Type.Number({ description: "Tab ID to search in." }),
		},
	);

	add(
		"form_input",
		"Browser form input",
		"Set values in form elements using element reference ID from the read_page tool.",
		{
			ref: Type.String({ description: "Element reference ID from the read_page tool." }),
			value: Type.Union([Type.String(), Type.Boolean(), Type.Number()], { description: "Value to set." }),
			tabId: Type.Number({ description: "Tab ID to set form value in." }),
		},
	);

	add("get_page_text", "Browser page text", "Extract raw text content from the page, prioritizing article content.", {
		tabId: Type.Number({ description: "Tab ID to extract text from." }),
	});

	add(
		"gif_creator",
		"Browser gif creator",
		"Manage GIF recording and export for browser automation sessions. (Stub: not yet implemented in the upstream extension.)",
		{
			action: Type.Union([
				Type.Literal("start_recording"),
				Type.Literal("stop_recording"),
				Type.Literal("export"),
				Type.Literal("clear"),
			]),
			tabId: Type.Number({ description: "Tab ID to identify which tab group this operation applies to." }),
			download: Type.Optional(Type.Boolean()),
			filename: Type.Optional(Type.String()),
			options: Type.Optional(
				Type.Object({
					showClickIndicators: Type.Optional(Type.Boolean()),
					showDragPaths: Type.Optional(Type.Boolean()),
					showActionLabels: Type.Optional(Type.Boolean()),
					showProgressBar: Type.Optional(Type.Boolean()),
					showWatermark: Type.Optional(Type.Boolean()),
					quality: Type.Optional(Type.Number()),
				}),
			),
		},
	);

	add(
		"javascript_tool",
		"Browser javascript",
		"Execute JavaScript code in the context of the current page. Returns the result of the last expression or any thrown errors.",
		{
			action: Type.Literal("javascript_exec"),
			text: Type.String({ description: "JavaScript code to evaluate in the page context." }),
			tabId: Type.Number({ description: "Tab ID to execute the code in." }),
		},
	);

	add(
		"read_console_messages",
		"Browser console messages",
		"Read browser console messages from a specific tab. Always provide a pattern to avoid getting too many irrelevant messages.",
		{
			tabId: Type.Number({ description: "Tab ID to read console messages from." }),
			pattern: Type.Optional(Type.String({ description: "Regex pattern to filter messages." })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of messages to return. Default 100." })),
			onlyErrors: Type.Optional(Type.Boolean()),
			clear: Type.Optional(Type.Boolean()),
		},
	);

	add(
		"read_network_requests",
		"Browser network requests",
		"Read HTTP network requests from a specific tab. Useful for debugging API calls and monitoring network activity.",
		{
			tabId: Type.Number({ description: "Tab ID to read network requests from." }),
			urlPattern: Type.Optional(Type.String({ description: "URL substring to filter by." })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of requests to return. Default 100." })),
			clear: Type.Optional(Type.Boolean()),
		},
	);

	add(
		"read_page",
		"Browser read page",
		"Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default.",
		{
			tabId: Type.Number({ description: "Tab ID to read from." }),
			filter: Type.Optional(Type.Union([Type.Literal("interactive"), Type.Literal("all")])),
			depth: Type.Optional(Type.Number({ description: "Maximum depth of the tree to traverse (default: 15)." })),
			ref_id: Type.Optional(Type.String({ description: "Reference ID of a parent element to read." })),
			max_chars: Type.Optional(Type.Number({ description: "Maximum characters for output (default: 50000)." })),
		},
	);

	add("resize_window", "Browser resize window", "Resize the current browser window to specified dimensions.", {
		width: Type.Number({ description: "Target window width in pixels." }),
		height: Type.Number({ description: "Target window height in pixels." }),
		tabId: Type.Number({ description: "Tab ID to get the window for." }),
	});

	add(
		"shortcuts_list",
		"Browser shortcuts list",
		"List all available shortcuts and workflows. (Stub: not yet implemented in the upstream extension.)",
		{ tabId: Type.Number() },
	);

	add(
		"shortcuts_execute",
		"Browser shortcuts execute",
		"Execute a shortcut or workflow. (Stub: not yet implemented in the upstream extension.)",
		{
			tabId: Type.Number(),
			shortcutId: Type.Optional(Type.String()),
			command: Type.Optional(Type.String()),
		},
	);

	add(
		"switch_browser",
		"Browser switch",
		"Hand off browser automation to a different Chromium browser (Chrome, Brave, Edge). One browser drives at a time. Calling this releases the current browser's hold on the shared runtime for ~15s so a target browser with this extension enabled can take over automatically.",
		{},
	);

	add(
		"update_plan",
		"Browser update plan",
		"Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach.",
		{
			domains: Type.Array(Type.String(), { description: "List of domains you will visit." }),
			approach: Type.Array(Type.String(), { description: "High-level description of what you will do." }),
		},
	);

	add(
		"debug",
		"Browser debug",
		"Read what this extension actually did, in one timestamped stream — the arguments a call was made with, what a click landed on, the coordinate space a screenshot was captured in, CDP commands and their durations, and input dispatches that failed.",
		{
			limit: Type.Optional(
				Type.Number({
					description: "How many of the most recent matching events to show (default 100, max 1000).",
				}),
			),
			kind: Type.Optional(
				Type.Union([
					Type.Literal("tool"),
					Type.Literal("cdp"),
					Type.Literal("input"),
					Type.Literal("hit"),
					Type.Literal("port"),
				]),
			),
			filter: Type.Optional(Type.String({ description: "Free-form match over each event, as a regex." })),
			tabId: Type.Optional(Type.Number()),
			since_ms: Type.Optional(Type.Number()),
			clear: Type.Optional(Type.Boolean()),
		},
	);

	add(
		"debug_timings",
		"Browser debug timings",
		"Diagnostics: return the extension's per-tool-call timing ring buffer plus a live snapshot of every MCP-group tab's scheduling-relevant state.",
		{
			limit: Type.Optional(Type.Number({ description: "Max timing entries to return (default 200, cap 600)." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading." })),
		},
	);

	add("get_config", "Browser get config", "Read the browser-automation settings this extension honors.", {
		tabId: Type.Optional(Type.Number()),
	});

	add(
		"set_config",
		"Browser set config",
		"Change a browser-automation setting. Call get_config first to see the recognized settings.",
		{
			key: Type.String({ description: 'Setting name, as listed by get_config (e.g. "humanize").' }),
			value: Type.Union([Type.Boolean(), Type.Number(), Type.String(), Type.Null()], {
				description: "New value for the setting. Use null to clear it.",
			}),
			tabId: Type.Optional(Type.Number({ description: "Scope this change to a single tab." })),
		},
	);

	add(
		"set_tab_focus",
		"Browser set tab focus",
		"Bring a tab to the user's attention: make it the selected tab in its window, and optionally raise that window.",
		{
			tabId: Type.Number(),
			focus_window: Type.Optional(Type.Boolean()),
		},
	);

	add(
		"upload_image",
		"Browser upload image",
		'Upload a previously captured screenshot to a file input. Identify the target with `ref` from read_page or find; the target must be an <input type="file">.',
		{
			imageId: Type.String({ description: "ID of a previously captured screenshot or a user-uploaded image." }),
			tabId: Type.Number(),
			ref: Type.String(),
			filename: Type.Optional(Type.String()),
		},
	);

	add(
		"file_upload",
		"Browser file upload",
		'Upload one or more local files (by absolute path) to a file input element on the page. Use read_page or find to locate the <input type="file">, then pass its ref.',
		{
			paths: Type.Array(Type.String(), { description: "Absolute paths to the files to upload." }),
			ref: Type.String(),
			tabId: Type.Number(),
		},
	);

	add(
		"retranscribe_recording",
		"Browser retranscribe recording",
		"Re-run transcription for a saved recording whose transcript failed at stop.",
		{
			recording_id: Type.String({
				description: "The recording_id shown in the bundle path after a recording_complete notification.",
			}),
		},
	);

	return defs;
}

/** The full set of tool names we expose — used by tests to assert parity with upstream. */
export const CHROME_BRIDGE_TOOL_NAMES = [
	"tabs_context_mcp",
	"tabs_create_mcp",
	"tabs_close_mcp",
	"navigate",
	"computer",
	"find",
	"form_input",
	"get_page_text",
	"gif_creator",
	"javascript_tool",
	"read_console_messages",
	"read_network_requests",
	"read_page",
	"resize_window",
	"shortcuts_list",
	"shortcuts_execute",
	"switch_browser",
	"update_plan",
	"debug",
	"debug_timings",
	"get_config",
	"set_config",
	"set_tab_focus",
	"upload_image",
	"file_upload",
	"retranscribe_recording",
] as const;
