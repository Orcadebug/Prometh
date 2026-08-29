import { ENV_PREFIX } from "../../config.js";

/**
 * Settings for the Chrome bridge — the in-process TCP client that talks to the
 * vendored open-claude-in-chrome Chromium extension. Activated when the user
 * runs `prometh --chrome-bridge` or sets `chromeBridge.enabled = true` in
 * `~/.prometh/settings.json`.
 */
export interface ChromeBridgeSettings {
	/** Enable the bridge (default: true once activated). */
	enabled?: boolean;
	/** TCP port the native host listens on (default: 18765). */
	port?: number;
	/** TCP host the native host binds to (default: 127.0.0.1). */
	host?: string;
	/** Auto-start the client when the AgentSession boots. Default: true. */
	autoStart?: boolean;
	/** Default per-request timeout, milliseconds. Default: 30_000. */
	requestTimeoutMs?: number;
}

export const CHROME_BRIDGE_DEFAULT_PORT = 18765;
export const CHROME_BRIDGE_DEFAULT_HOST = "127.0.0.1";
export const CHROME_BRIDGE_DEFAULT_TIMEOUT_MS = 30_000;

export const ENV_CHROME_BRIDGE_PORT = `${ENV_PREFIX}_CHROME_BRIDGE_PORT`;
export const ENV_CHROME_BRIDGE_HOST = `${ENV_PREFIX}_CHROME_BRIDGE_HOST`;

/** Merge user settings with env-var overrides and built-in defaults. */
export function resolveChromeBridgeSettings(
	userSettings: ChromeBridgeSettings | undefined,
): Required<ChromeBridgeSettings> {
	const envPort = process.env[ENV_CHROME_BRIDGE_PORT];
	const envHost = process.env[ENV_CHROME_BRIDGE_HOST];
	return {
		enabled: userSettings?.enabled ?? true,
		port: parseInt(envPort ?? "", 10) || userSettings?.port || CHROME_BRIDGE_DEFAULT_PORT,
		host: envHost || userSettings?.host || CHROME_BRIDGE_DEFAULT_HOST,
		autoStart: userSettings?.autoStart ?? true,
		requestTimeoutMs: userSettings?.requestTimeoutMs ?? CHROME_BRIDGE_DEFAULT_TIMEOUT_MS,
	};
}
