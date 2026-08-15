/**
 * Namespaced `_meta` payloads for prometh capabilities that ACP has no
 * native concept for (IPython cell semantics, RLM subagents, autonomous gates,
 * goals, heartbeats, continual harness state).
 *
 * ACP reserves `_meta` on capability objects, notifications, tool calls, and
 * content blocks precisely so agents can carry non-standard data. Vanilla ACP
 * clients ignore these keys; a prometh-aware client (or the verifiers
 * harness) reads them. Never add non-standard fields to an ACP object root.
 */

/** Reverse-domain namespace for every prometh `_meta` payload. */
export const PROMETH_META_NAMESPACE = "ai.orcadebug.prometh";

export interface PromethSubagentMeta {
	id: string;
	sessionName?: string;
	status: string;
	model?: string;
	depth?: number;
	tokenCount?: number;
	error?: string;
}

export interface PromethAutonomousMeta {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	gateAttempt?: number;
	gateFailure?: string;
	limitReason?: string;
}

export interface PromethIpythonAttachmentMeta {
	mimeType?: string;
	path?: string;
	bytes?: number;
}

export interface PromethIpythonMeta {
	/** Media the cell loaded into context, as reported by the ipython tool. */
	attachments?: PromethIpythonAttachmentMeta[];
	/** Number of diffs the cell displayed. */
	diffCount?: number;
}

export interface PromethGoalMeta {
	status: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed?: number;
}

export interface PromethRefinementMeta {
	status: "complete" | "failed";
	summary?: string;
	changes?: string[];
	error?: string;
}

export interface PromethAgentMessageMeta {
	toolCallId: string;
	target?: string;
	deliveryStatus?: string;
}

export interface PromethCwdMeta {
	/** The cwd the client asked for. */
	requested: string;
	/** The cwd prometh is actually running in, fixed at startup. */
	actual: string;
}

export interface PromethSessionMeta {
	/** Present when a client-requested cwd differs from the agent's real cwd. */
	cwd?: PromethCwdMeta;
	/** Set when the session's heartbeat or cron schedule changed. */
	heartbeatsChanged?: boolean;
	goal?: PromethGoalMeta;
	refinement?: PromethRefinementMeta;
	agentMessage?: PromethAgentMessageMeta;
	sessionId?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	compaction?: { tokensBefore?: number; summary?: string };
	subagents?: PromethSubagentMeta[];
	autonomous?: PromethAutonomousMeta;
	ipython?: PromethIpythonMeta;
}

/** Wrap a prometh payload in its reverse-domain `_meta` envelope. */
export function promethMeta(payload: PromethSessionMeta): Record<string, unknown> {
	return { [PROMETH_META_NAMESPACE]: payload };
}
