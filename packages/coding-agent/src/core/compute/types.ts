/**
 * Provider-neutral compute subsystem types.
 *
 * The compute subsystem executes real computational work (commands, scripts,
 * kernels) through interchangeable backends. The TypeScript host owns job
 * state, budgets, persistence, and lifecycle; backends only execute.
 */

export type ComputeJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ComputeBackendId = "local" | "kaggle";

/**
 * Requested isolation for a compute job. `local` executes in the session
 * working directory, `worktree` executes inside a disposable git worktree
 * created for the job. Future backends may add `container` and `sandbox`.
 */
export type ComputeIsolation = "local" | "worktree";

/** Scalar values allowed inside compute metrics. */
export type ComputeMetricValue = number | string | boolean;

export interface ComputeJobBudgets {
	/** Wall-clock timeout for a single job, in milliseconds. */
	timeoutMs?: number;
	/** Maximum captured stdout bytes. */
	maxStdoutBytes?: number;
	/** Maximum captured stderr bytes. */
	maxStderrBytes?: number;
}

/** A structured artifact reference produced or registered by a job. */
export interface ComputeArtifact {
	/** Kind of artifact: logs, metrics, plot, checkpoint, source, report, dataset, trace. */
	kind: string;
	/** Absolute path of the artifact file on the host. */
	path: string;
	/** Optional compact summary (kept small; never whole file contents). */
	summary?: string;
	/** Optional machine-readable metadata. */
	metadata?: Record<string, unknown>;
}

/**
 * Machine-readable result emitted by an experiment process via the
 * `prime_discovery_result` JSON convention or a result file.
 */
export interface StructuredResult {
	metrics: Record<string, ComputeMetricValue>;
	valid: boolean;
	notes?: string;
	predicted_metrics?: Record<string, ComputeMetricValue>;
	/** Extra arbitrary payload written by the experiment. */
	extra?: Record<string, unknown>;
}

export interface ComputeResult {
	status: ComputeJobStatus;
	exitCode: number | null;
	/** Captured stdout, bounded by job budgets. */
	stdout: string;
	/** Captured stderr, bounded by job budgets. */
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	/** True when the job exceeded its wall-clock budget. */
	timedOut: boolean;
	/** Optional error message when the job could not run at all. */
	error?: string;
	/** Machine-readable result, when the job followed the result protocol. */
	structuredResult?: StructuredResult;
	/** Machine-readable metrics (structuredResult.metrics when present). */
	metrics: Record<string, ComputeMetricValue>;
	/** Absolute path of the job working directory. */
	workDir: string;
	artifacts: ComputeArtifact[];
	startedAt: string;
	completedAt: string;
	/** Real wall-clock execution duration in milliseconds. */
	durationMs: number;
}

/** A request to execute real computational work on some backend. */
export interface ComputeRequest {
	/** Shell command to execute. */
	command: string;
	backend?: ComputeBackendId;
	/** Isolation mode. Defaults to "local". */
	isolation?: ComputeIsolation;
	/** Optional label to identify the job in listings. */
	label?: string;
	/** Requested budgets for this job. Unset budgets inherit runtime defaults. */
	budgets?: ComputeJobBudgets;
	/** Declared accelerator for accounting (informational on the local backend). */
	accelerator?: string;
	/** Optional declared estimate of compute duration in milliseconds, for accounting. */
	estimatedDurationMs?: number;
	/** Optional path to a result JSON file the job writes (result protocol alternative). */
	resultFile?: string;
	/**
	 * Optional structured job definition. Backends that support structured
	 * jobs interpret it (e.g. Kaggle kernel metadata); the local backend
	 * materializes `files` into the job working directory before running
	 * the command.
	 */
	files?: Array<{ path: string; content: string }>;
	/** Free-form metadata (hypothesis, variant labels, campaign references). */
	metadata?: Record<string, unknown>;
}

/** Handle returned synchronously when a job is accepted for execution. */
export interface ComputeSubmission {
	/** Durable job id, unique per runtime. */
	jobId: string;
	backend: ComputeBackendId;
	status: ComputeJobStatus;
	startedAt: string;
	/** Absolute path to the job working directory (local backend). */
	workDir?: string;
}

/** Live status of a tracked job. */
export interface ComputeJobStatusSnapshot {
	jobId: string;
	backend: ComputeBackendId;
	status: ComputeJobStatus;
	startedAt: string;
	completedAt?: string;
	error?: string;
}

/** Resource accounting snapshot for the runtime. */
export interface ComputeBudgetSnapshot {
	jobsSubmitted: number;
	jobsCompleted: number;
	jobsFailed: number;
	jobsCancelled: number;
	jobsRunning: number;
	/** Sum of wall-clock execution durations for finished jobs, in milliseconds. */
	totalDurationMs: number;
	/** Sum of declared estimated durations for submitted jobs, in milliseconds. */
	estimatedDurationMs: number;
	/** Sum of declared GPU-accelerated jobs. */
	gpuJobs: number;
	/** Runtime-configured limits. */
	limits: {
		maxConcurrency: number;
		maxJobs: number | null;
		maxWallTimeMs: number | null;
		defaultTimeoutMs: number;
		maxStdoutBytes: number;
		maxStderrBytes: number;
	};
	/** Available backends. */
	backends: Array<{ id: ComputeBackendId; available: boolean }>;
}

export interface ComputeRuntimeOptions {
	/** Default working directory for local jobs. */
	defaultCwd: string;
	/** Maximum concurrent running jobs across backends. */
	maxConcurrency?: number;
	/** Maximum total jobs this runtime will ever accept. */
	maxJobs?: number;
	/** Maximum total wall-clock job execution across the runtime, in milliseconds. */
	maxWallTimeMs?: number;
	/** Default per-job timeout in milliseconds. */
	defaultTimeoutMs?: number;
	/** Default maximum captured stdout bytes per job. */
	maxStdoutBytes?: number;
	/** Default maximum captured stderr bytes per job. */
	maxStderrBytes?: number;
	/** Enable the kaggle backend (still requires the CLI + auth to be usable). */
	enableKaggle?: boolean;
	/** Directory for durable job state; when omitted the runtime is in-memory only. */
	stateDir?: string;
	/** Whether repository git worktree isolation may be used. */
	allowWorktreeIsolation?: boolean;
	/** Optional signal for cancelling all pending/running jobs (session shutdown). */
	signal?: AbortSignal;
}

/** Result of polling a job for completion. */
export interface ComputeResultPoll {
	jobId: string;
	status: ComputeJobStatus;
	result?: ComputeResult;
	error?: string;
}

export interface ComputeJobRecord extends ComputeJobStatusSnapshot {
	request: ComputeRequest;
	result?: ComputeResult;
}

export const DEFAULT_LOCAL_COMPUTE_LIMITS = {
	maxConcurrency: 2,
	defaultTimeoutMs: 20 * 60 * 1000,
	maxStdoutBytes: 256 * 1024,
	maxStderrBytes: 256 * 1024,
} as const;
