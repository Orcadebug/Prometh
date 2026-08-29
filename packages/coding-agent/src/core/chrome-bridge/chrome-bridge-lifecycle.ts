import { ChromeBridgeClient } from "./chrome-bridge-client.js";
import { type ChromeBridgeSettings, resolveChromeBridgeSettings } from "./chrome-bridge-settings.js";

/**
 * Build a `ChromeBridgeClient` from user settings. Does not block on
 * connection — the client tolerates the native host being down and
 * reconnects on its own backoff. Lifetime is owned by `AgentSession`.
 */
export function startChromeBridge(
	userSettings: ChromeBridgeSettings | undefined,
	logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): ChromeBridgeClient {
	const settings = resolveChromeBridgeSettings(userSettings);
	const client = new ChromeBridgeClient({
		port: settings.port,
		host: settings.host,
		requestTimeoutMs: settings.requestTimeoutMs,
		logger,
	});
	if (settings.autoStart) {
		client.connect();
	}
	return client;
}

/** Close the client. Safe to call with `undefined` (no-op). */
export async function stopChromeBridge(client: ChromeBridgeClient | undefined): Promise<void> {
	if (!client) return;
	await client.dispose();
}
