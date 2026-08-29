import type { HostRequestHandlers } from "../kernel/index.js";
import type { ChromeBridgeClient } from "./chrome-bridge-client.js";
import { CHROME_BRIDGE_TOOL_NAMES } from "./chrome-bridge-tools.js";

/**
 * Build the host-request handlers that let the IPython kernel reach the
 * chrome-bridge client from Python cells. Mounted by AgentSession next to
 * `mcp.*` and `rlm.*` handlers in `_createKernelHostHandlers`. Plain
 * 1-arg handlers, matching the shape returned by `McpManager.hostHandlers()`
 * and `createComputeHostHandlers()`.
 */
export function createChromeBridgeHostHandlers(client: ChromeBridgeClient): HostRequestHandlers {
	return {
		"chrome.bridge.call": async (payload) => {
			const method = typeof payload.method === "string" ? payload.method : "";
			if (!method) throw new Error("chrome.bridge.call: `method` is required");
			const params = (payload.params ?? {}) as Record<string, unknown>;
			const result = await client.request({ tool: method, args: params });
			return { result };
		},
		"chrome.bridge.status": async () => client.status(),
		"chrome.bridge.list": async () => ({
			tools: [...CHROME_BRIDGE_TOOL_NAMES],
		}),
	};
}
