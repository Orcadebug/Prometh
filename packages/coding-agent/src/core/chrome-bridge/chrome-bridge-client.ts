import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { connect } from "node:net";

/**
 * Event shape emitted by the upstream open-claude-in-chrome extension via the
 * native host → TCP bridge. These are server-initiated notifications, not
 * responses to a request, so we surface them as events on the client.
 */
export type ChromeBridgeEvent =
	| { type: "recording_saved"; recording_id: string; path?: string; ok: boolean; error?: string }
	| { type: "screenshot_saved"; id?: string; path?: string; ok: boolean; error?: string }
	| { type: "tabs_changed"; tabs?: unknown }
	| { type: string; [key: string]: unknown };

/**
 * A tool invocation sent to the vendored OCIC MCP server (tool-runtime.js).
 *
 * The wire protocol is newline-delimited JSON. A client connection is
 * classified as a *client* (rather than a native host) by sending
 * `{"type": "client_hello"}` as the very first line. After the server replies
 * with `{"type": "client_ack", clientId}`, tool calls are sent as
 * `{"type": "tool_request", id, tool, args}` and the response comes back as
 * `{id, ...}` (the server strips its client-prefixed id before forwarding).
 */
export interface ChromeBridgeRequest {
	/** Tool name (e.g. "navigate", "computer"). */
	tool: string;
	/** Tool arguments — the parameters for the tool call. */
	args: Record<string, unknown>;
}

export interface ChromeBridgeResponse {
	id: string;
	type?: string;
	/** Successful tool result. */
	result?: unknown;
	/** Error payload from upstream. */
	error?: string | { message?: string; [key: string]: unknown };
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timeoutHandle: NodeJS.Timeout;
	signal?: AbortSignal;
	abortHandler?: () => void;
}

export interface ChromeBridgeClientOptions {
	port: number;
	host: string;
	/** Default per-request timeout in ms. Default: 30_000. */
	requestTimeoutMs?: number;
	/** How often to retry when the connection drops (the MCP server is gone). Default: 1500. */
	retryIntervalMs?: number;
	/** Slow-lane retry interval after upstream rejects us (another browser holds the slot). Default: 15000. */
	rejectedRetryIntervalMs?: number;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * In-process TCP client that talks to the vendored open-claude-in-chrome MCP
 * server (mcp-server.js, which hosts tool-runtime.js) on `127.0.0.1:18765`
 * (configurable). Speaks newline-delimited JSON.
 *
 * Flow:
 *   1. connect → send `{"type": "client_hello"}` on the first line
 *   2. wait for `{"type": "client_ack", clientId}`
 *   3. send `{"type": "tool_request", id, tool, args}` for each tool call
 *   4. match the response by `id`
 *
 * The MCP server binds the port and also accepts the native host (the
 * Chromium side) as a *second* connection. Reconnects with a 1.5s / 15s
 * backoff so the client and server have symmetrical retry behavior.
 */
export class ChromeBridgeClient extends EventEmitter {
	private socket: Socket | null = null;
	private buffer = "";
	private pending = new Map<string, PendingRequest>();
	/** Writes queued while the socket is mid-connect; flushed after client_ack. */
	private writeQueue: string[] = [];
	private disposed = false;
	private retryTimer: NodeJS.Timeout | null = null;
	private rejected = false;
	private lastError: string | undefined;
	private handshaken = false;

	constructor(public readonly options: ChromeBridgeClientOptions) {
		super();
	}

	/** Open the connection. Idempotent; safe to call repeatedly. */
	connect(): void {
		if (this.disposed) return;
		if (this.socket) return;
		const sock = connect(this.options.port, this.options.host);
		this.socket = sock;
		this.handshaken = false;
		sock.setNoDelay(true);
		sock.on("connect", () => {
			this.lastError = undefined;
			// The first line MUST be client_hello for the server to classify us.
			sock.write(`${JSON.stringify({ type: "client_hello" })}\n`);
			this.options.logger?.info(`chrome-bridge connected to ${this.options.host}:${this.options.port}`);
		});
		sock.on("data", (chunk) => this.handleData(chunk.toString("utf-8")));
		sock.on("error", (err) => {
			this.lastError = String(err?.message ?? err);
			this.options.logger?.warn(`chrome-bridge socket error: ${this.lastError}`);
		});
		sock.on("close", () => {
			this.socket = null;
			this.handshaken = false;
			this.writeQueue = [];
			// Reject in-flight requests so callers don't hang.
			for (const [, entry] of this.pending) {
				clearTimeout(entry.timeoutHandle);
				entry.reject(new Error("chrome-bridge: connection lost"));
			}
			this.pending.clear();
			this.emit("disconnected");
			this.scheduleReconnect();
		});
	}

	private scheduleReconnect(): void {
		if (this.disposed) return;
		if (this.retryTimer) return;
		const interval = this.rejected
			? (this.options.rejectedRetryIntervalMs ?? 15_000)
			: (this.options.retryIntervalMs ?? 1500);
		this.rejected = false;
		this.retryTimer = setInterval(() => {
			if (!this.socket && !this.disposed) this.connect();
		}, interval);
		// Unref so the timer doesn't keep the process alive on shutdown.
		this.retryTimer.unref?.();
	}

	private handleData(text: string): void {
		this.buffer += text;
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl === -1) break;
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let parsed: ChromeBridgeResponse | ChromeBridgeEvent;
			try {
				parsed = JSON.parse(line) as ChromeBridgeResponse;
			} catch {
				continue;
			}
			// client_ack completes the handshake.
			if ((parsed as { type?: string }).type === "client_ack") {
				this.handshaken = true;
				// Drain any writes that arrived while we were waiting for the ack.
				for (const wire of this.writeQueue) {
					this.socket?.write(wire);
				}
				this.writeQueue = [];
				this.emit("connected");
				continue;
			}
			const id = (parsed as { id?: unknown }).id;
			if (typeof id === "string" && this.pending.has(id)) {
				const entry = this.pending.get(id)!;
				this.pending.delete(id);
				clearTimeout(entry.timeoutHandle);
				if (entry.signal && entry.abortHandler) {
					entry.signal.removeEventListener("abort", entry.abortHandler);
				}
				if (parsed.error) {
					const message =
						typeof parsed.error === "string"
							? parsed.error
							: (parsed.error.message ?? JSON.stringify(parsed.error));
					entry.reject(new Error(`chrome-bridge: ${message}`));
				} else {
					entry.resolve(parsed.result);
				}
				continue;
			}
			// No id, or id we don't recognize — treat as server-initiated event.
			if (
				typeof (parsed as { error?: string }).error === "string" &&
				/another browser profile/i.test((parsed as { error: string }).error)
			) {
				this.rejected = true;
			}
			this.emit("event", parsed as ChromeBridgeEvent);
		}
	}

	/**
	 * Send a tool request and await the matching response. Stamps a UUID on
	 * the outgoing payload as `id`; the server echoes it back.
	 */
	request(payload: ChromeBridgeRequest, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
		if (this.disposed) {
			return Promise.reject(new Error("chrome-bridge: client is disposed"));
		}
		if (!this.socket) {
			this.connect();
		}
		const id = randomUUID();
		const timeoutMs = opts?.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
		return new Promise<unknown>((resolve, reject) => {
			const entry: PendingRequest = {
				resolve,
				reject,
				timeoutHandle: setTimeout(() => {
					if (this.pending.delete(id)) {
						if (opts?.signal && entry.abortHandler) {
							opts.signal.removeEventListener("abort", entry.abortHandler);
						}
						reject(new Error(`chrome-bridge: request timed out after ${timeoutMs}ms`));
					}
				}, timeoutMs),
			};
			if (opts?.signal) {
				if (opts.signal.aborted) {
					clearTimeout(entry.timeoutHandle);
					reject(new Error("aborted"));
					return;
				}
				entry.abortHandler = () => {
					if (this.pending.delete(id)) {
						clearTimeout(entry.timeoutHandle);
						reject(new Error("aborted"));
					}
				};
				opts.signal.addEventListener("abort", entry.abortHandler, { once: true });
				entry.signal = opts.signal;
			}
			this.pending.set(id, entry);
			const wire = `${JSON.stringify({ type: "tool_request", id, tool: payload.tool, args: payload.args })}\n`;
			if (this.socket && this.handshaken) {
				this.socket.write(wire);
			} else {
				// `connect()` is async and the handshake must complete first —
				// the writeQueue is drained in the client_ack handler.
				this.writeQueue.push(wire);
			}
		});
	}

	/** Snapshot the current connection state (for the host-request `chrome.bridge.status`). */
	status(): { connected: boolean; port: number; host: string; pending: number; lastError?: string } {
		return {
			connected: !!this.socket && this.handshaken,
			port: this.options.port,
			host: this.options.host,
			pending: this.pending.size,
			lastError: this.lastError,
		};
	}

	/** Close the socket and reject all in-flight requests. Idempotent. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.retryTimer) {
			clearInterval(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.socket) {
			const sock = this.socket;
			this.socket = null;
			await new Promise<void>((resolve) => {
				sock.end(() => resolve());
				sock.once("close", () => resolve());
				setTimeout(() => resolve(), 200).unref?.();
			});
		}
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timeoutHandle);
			entry.reject(new Error("chrome-bridge: client disposed"));
		}
		this.pending.clear();
		this.writeQueue = [];
	}
}
