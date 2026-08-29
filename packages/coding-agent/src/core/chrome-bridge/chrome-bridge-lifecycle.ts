import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromeBridgeClient } from "./chrome-bridge-client.js";
import { type ChromeBridgeSettings, resolveChromeBridgeSettings } from "./chrome-bridge-settings.js";

/**
 * Absolute path to the vendored OCIC MCP server.
 *
 * Repo layout (relative to this source file):
 *   packages/coding-agent/src/core/chrome-bridge/chrome-bridge-lifecycle.ts
 *   → ../../../../../../extensions/open-claude-in-chrome/host/mcp-server.js
 */
function vendoredMcpServerPath(): string | undefined {
	const here = fileURLToPath(import.meta.url);
	// src/core/chrome-bridge/ → repo root
	const repoRoot = dirname(dirname(dirname(dirname(dirname(dirname(here))))));
	const candidate = join(repoRoot, "extensions", "open-claude-in-chrome", "host", "mcp-server.js");
	return existsSync(candidate) ? candidate : undefined;
}

export interface ChromeBridgeProcess {
	client: ChromeBridgeClient;
	serverProcess: ChildProcess | null;
}

/**
 * Start the vendored OCIC MCP server (mcp-server.js → tool-runtime.js) as a
 * child process, which binds `127.0.0.1:18765`, and connect the in-process
 * bridge client to it. The native host (Chromium side) connects to the same
 * port as a second connection.
 *
 * Returns `{ client, serverProcess }`. If the vendored server can't be found
 * (e.g. the extensions/ subtree was pruned), the client is still returned but
 * will never connect — tool calls fail with a clear "connection lost" error.
 */
export function startChromeBridge(
	userSettings: ChromeBridgeSettings | undefined,
	logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): ChromeBridgeProcess {
	const settings = resolveChromeBridgeSettings(userSettings);

	// Spawn the vendored MCP server first — it owns the TCP port.
	const serverPath = vendoredMcpServerPath();
	let serverProcess: ChildProcess | null = null;
	if (serverPath) {
		serverProcess = spawn(process.execPath, [serverPath], {
			// stdio "pipe" keeps stdin OPEN (the server exits when stdin ends,
			// because it's an MCP stdio front-end). We never write to it and
			// never end it, so the server stays alive for the session.
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});
		// Don't let our pipe holding stdin keep the parent alive after exit.
		serverProcess.stdin?.on("error", () => {});
		serverProcess.stdout?.on("data", (d) => {
			logger?.info(`[chrome-bridge server] ${String(d).trim()}`);
		});
		serverProcess.stderr?.on("data", (d) => {
			logger?.warn(`[chrome-bridge server] ${String(d).trim()}`);
		});
		serverProcess.on("error", (err) => {
			logger?.error(`chrome-bridge server spawn error: ${err.message}`);
		});
	} else {
		logger?.warn("chrome-bridge: vendored mcp-server.js not found; bridge will be inert");
	}

	const client = new ChromeBridgeClient({
		port: settings.port,
		host: settings.host,
		requestTimeoutMs: settings.requestTimeoutMs,
		logger,
	});
	if (settings.autoStart) {
		client.connect();
	}
	return { client, serverProcess };
}

/** Close the client and kill the spawned MCP server. Safe to call with `undefined`. */
export async function stopChromeBridge(bridge: ChromeBridgeProcess | undefined): Promise<void> {
	if (!bridge) return;
	const { client, serverProcess } = bridge;
	await client.dispose();
	if (serverProcess && serverProcess.exitCode === null && !serverProcess.killed) {
		// Ending stdin is the MCP server's clean-exit path (its stdin.on("end")
		// handler calls exitClean). Then SIGTERM as a backstop.
		serverProcess.stdin?.end();
		serverProcess.kill("SIGTERM");
		// Give it a moment, then force-kill if it doesn't exit.
		setTimeout(() => {
			if (serverProcess.exitCode === null && !serverProcess.killed) {
				serverProcess.kill("SIGKILL");
			}
		}, 1000).unref?.();
	}
}
