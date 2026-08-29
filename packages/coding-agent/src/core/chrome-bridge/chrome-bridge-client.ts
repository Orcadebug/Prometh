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
 * Upstream tool calls (computer, navigate, read_page, ...) are routed by the
 * `type` field on the wire. The native host forwards them as
 * `{type, ...payload}\n` and the matching extension reply comes back as
 * `{id, type: "result"|"error", result?, error?}\n` keyed by the `id` we
 * stamp on the request.
 */
export interface ChromeBridgeRequest {
	/** Tool/method name (matches upstream `type` field, e.g. "navigate", "computer"). */
	type: string;
	/** Optional payload — the parameters for the tool call. */
	[key: string]: unknown;
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
	/** How often to retry when the connection drops (the native host is gone). Default: 1500. */
	retryIntervalMs?: number;
	/** Slow-lane retry interval after upstream rejects us (another browser holds the slot). Default: 15000. */
	rejectedRetryIntervalMs?: number;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * In-process TCP client that talks to the vendored open-claude-in-chrome
 * native host on `127.0.0.1:18765` (configurable). Speaks newline-delimited
 * JSON; one request = one line out, one line back (matched by `id`).
 *
 * Reconnects with the same backoff as upstream `native-host.js` so the client
 * and server have symmetrical retry behavior. The native host's lifetime is
 * tied to the browser/extension, so the client must tolerate long outages
 * (browser closed, extension reloaded, laptop asleep).
 */
export class ChromeBridgeClient extends EventEmitter {
	private socket: Socket | null = null;
	private buffer = "";
	private pending = new Map<string, PendingRequest>();
	/** Writes queued while the socket is mid-connect; flushed in the 'connect' handler. */
	private writeQueue: string[] = [];
	private disposed = false;
	private retryTimer: NodeJS.Timeout | null = null;
	private rejected = false;
	private lastError: string | undefined;

	constructor(public readonly options: ChromeBridgeClientOptions) {
		super();
	}

	/** Open the connection. Idempotent; safe to call repeatedly. */
	connect(): void {
		if (this.disposed) return;
		if (this.socket) return;
		const sock = connect(this.options.port, this.options.host);
		this.socket = sock;
		sock.setNoDelay(true);
		sock.on("connect", () => {
			this.lastError = undefined;
			// Drain any writes that arrived while the socket was connecting.
			for (const wire of this.writeQueue) {
				sock.write(wire);
			}
			this.writeQueue = [];
			this.emit("connected");
			this.options.logger?.info(`chrome-bridge connected to ${this.options.host}:${this.options.port}`);
		});
		sock.on("data", (chunk) => this.handleData(chunk.toString("utf-8")));
		sock.on("error", (err) => {
			this.lastError = String(err?.message ?? err);
			this.options.logger?.warn(`chrome-bridge socket error: ${this.lastError}`);
		});
		sock.on("close", () => {
			this.socket = null;
			this.writeQueue = [];
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
			// The upstream extension rejects the loser of the slot with a string
			// "another browser profile" error; surface that so the next retry
			// backs off into the slow lane.
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
	 * Send a request and await the matching response. Stamps a UUID on the
	 * outgoing payload as `id`; the server echoes it back.
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
			const wire = `${JSON.stringify({ id, ...payload })}\n`;
			if (this.socket) {
				this.socket.write(wire);
			} else {
				// `connect()` is async — the writeQueue is drained in the 'connect' handler.
				this.writeQueue.push(wire);
			}
		});
	}

	/** Snapshot the current connection state (for the host-request `chrome.bridge.status`). */
	status(): { connected: boolean; port: number; host: string; pending: number; lastError?: string } {
		return {
			connected: !!this.socket,
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
