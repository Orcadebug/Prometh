/**
 * Authoritative host-side compute runtime.
 *
 * Owns job lifecycle, budgets, concurrency, and durable persistence. Backends
 * only execute; the runtime decides what may run and records what happened.
 * Job state is stored under the session artifact directory when provided so
 * it survives normal session continuation.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputeBackend } from "./backends/base.js";
import { KaggleComputeBackend } from "./backends/kaggle.js";
import { LocalComputeBackend } from "./backends/local.js";
import type {
	ComputeBackendId,
	ComputeBudgetSnapshot,
	ComputeJobRecord,
	ComputeJobStatus,
	ComputeJobStatusSnapshot,
	ComputeRequest,
	ComputeResult,
	ComputeResultPoll,
	ComputeRuntimeOptions,
	ComputeSubmission,
} from "./types.js";
import { createWorktree, isGitRepository, type WorktreeHandle } from "./worktree.js";

const DEFAULT_STATE_FILE = "compute-runtime-state.json";
const RESULT_POLL_INTERVAL_MS = 250;

interface PersistedComputeState {
	version: 1;
	jobs: Array<{
		jobId: string;
		backend: ComputeBackendId;
		status: ComputeJobStatus;
		startedAt: string;
		completedAt?: string;
		error?: string;
		request: ComputeRequest;
		result?: ComputeResult;
	}>;
}

interface RuntimeJobRecord extends ComputeJobRecord {
	/** True once the job's accounting has been applied; prevents double counting. */
	accounted: boolean;
}

const VALID_STATUSES: readonly ComputeJobStatus[] = ["pending", "running", "completed", "failed", "cancelled"];

export class ComputeRuntime {
	private readonly backends = new Map<ComputeBackendId, ComputeBackend>();
	private readonly jobs = new Map<string, RuntimeJobRecord>();
	private readonly worktreeHandles = new Set<WorktreeHandle>();
	private readonly limits: {
		maxConcurrency: number;
		maxJobs: number | null;
		maxWallTimeMs: number | null;
		defaultTimeoutMs: number;
		maxStdoutBytes: number;
		maxStderrBytes: number;
	};
	private readonly stateFile: string | undefined;
	private jobsSubmitted = 0;
	private jobsCompleted = 0;
	private jobsFailed = 0;
	private jobsCancelled = 0;
	private totalDurationMs = 0;
	private estimatedDurationMs = 0;
	private gpuJobs = 0;
	private disposed = false;

	constructor(private readonly options: ComputeRuntimeOptions) {
		this.limits = {
			maxConcurrency: options.maxConcurrency ?? 2,
			maxJobs: options.maxJobs ?? null,
			maxWallTimeMs: options.maxWallTimeMs ?? null,
			defaultTimeoutMs: options.defaultTimeoutMs ?? 20 * 60 * 1000,
			maxStdoutBytes: options.maxStdoutBytes ?? 256 * 1024,
			maxStderrBytes: options.maxStderrBytes ?? 256 * 1024,
		};
		if (options.stateDir) {
			mkdirSync(options.stateDir, { recursive: true });
			this.stateFile = join(options.stateDir, DEFAULT_STATE_FILE);
		}
		this._registerBackends();
		this._restore();
	}

	get defaultCwd(): string {
		return this.options.defaultCwd;
	}

	async availableBackends(): Promise<Array<{ id: ComputeBackendId; available: boolean }>> {
		const entries: Array<{ id: ComputeBackendId; available: boolean }> = [];
		for (const backend of this.backends.values()) {
			entries.push({ id: backend.id as ComputeBackendId, available: await backend.available() });
		}
		return entries;
	}

	async backendAvailable(backendId: ComputeBackendId): Promise<boolean> {
		const backend = this.backends.get(backendId);
		if (!backend) {
			return false;
		}
		return backend.available();
	}

	/**
	 * Submit a job for execution. Validates the request, enforces budgets,
	 * and returns a durable submission handle.
	 */
	async submit(request: ComputeRequest): Promise<ComputeSubmission> {
		if (this.options.signal?.aborted) {
			throw new Error("compute runtime is shutting down");
		}
		this._validateRequest(request);
		if (this.limits.maxJobs !== null && this.jobsSubmitted >= this.limits.maxJobs) {
			throw new Error(`compute job budget exhausted: max ${this.limits.maxJobs} jobs`);
		}
		if (this._runningJobCount() >= this.limits.maxConcurrency) {
			throw new Error(`compute concurrency bound reached: max ${this.limits.maxConcurrency} concurrent jobs`);
		}
		const backendId = request.backend ?? "local";
		const backend = this.backends.get(backendId);
		if (!backend) {
			throw new Error(`compute backend "${backendId}" is not registered`);
		}
		if (!(await backend.available())) {
			throw new Error(`compute backend "${backendId}" is not available`);
		}

		const worktreeHandle =
			request.isolation === "worktree" && backendId === "local" ? this._prepareWorktreeIsolation() : undefined;
		if (worktreeHandle) {
			this.worktreeHandles.add(worktreeHandle);
		}

		const submission = await backend.submit({
			...request,
			...(worktreeHandle ? { metadata: { ...request.metadata, worktreePath: worktreeHandle.path } } : {}),
		});
		const record: RuntimeJobRecord = {
			jobId: submission.jobId,
			backend: backendId,
			status: submission.status,
			startedAt: submission.startedAt,
			request,
			accounted: false,
		};
		this.jobs.set(record.jobId, record);
		this.jobsSubmitted++;
		this.estimatedDurationMs += request.estimatedDurationMs ?? 0;
		if (request.accelerator) {
			this.gpuJobs++;
		}
		this._persist();
		void this._trackCompletion(record, backend);
		return { ...submission, workDir: submission.workDir ?? worktreeHandle?.path };
	}

	async status(jobId: string): Promise<ComputeJobStatusSnapshot> {
		const record = this._requireJob(jobId);
		return {
			jobId: record.jobId,
			backend: record.backend,
			status: record.status,
			startedAt: record.startedAt,
			completedAt: record.completedAt,
			error: record.error,
		};
	}

	/** Block until the job finishes and return its result. */
	async result(jobId: string, _pollIntervalMs = RESULT_POLL_INTERVAL_MS): Promise<ComputeResult> {
		const record = this._requireJob(jobId);
		if (record.result) {
			return record.result;
		}
		const backend = this.backends.get(record.backend);
		if (!backend) {
			throw new Error(`compute backend "${record.backend}" is not registered`);
		}
		const result = await backend.result(jobId);
		this._applyResult(record, result);
		return result;
	}

	/** Non-blocking poll of a job: returns its result when finished. */
	async poll(jobId: string): Promise<ComputeResultPoll> {
		const record = this._requireJob(jobId);
		if (record.result) {
			return { jobId, status: record.status, result: record.result };
		}
		const backend = this.backends.get(record.backend);
		if (!backend) {
			return { jobId, status: record.status, error: `compute backend "${record.backend}" is not registered` };
		}
		const snapshot = await backend.status(jobId);
		record.status = snapshot.status;
		record.completedAt = snapshot.completedAt ?? record.completedAt;
		record.error = snapshot.error ?? record.error;
		if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled") {
			const result = await backend.result(jobId);
			this._applyResult(record, result);
			return { jobId, status: record.status, result };
		}
		return { jobId, status: record.status };
	}

	async cancel(jobId: string): Promise<void> {
		const record = this._requireJob(jobId);
		const backend = this.backends.get(record.backend);
		if (!backend) {
			throw new Error(`compute backend "${record.backend}" is not registered`);
		}
		if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
			return;
		}
		if (!backend.cancel) {
			throw new Error(`compute backend "${record.backend}" does not support cancellation`);
		}
		await backend.cancel(jobId);
		record.status = "cancelled";
		record.completedAt = new Date().toISOString();
		this._persist();
	}

	async list(): Promise<ComputeJobRecord[]> {
		return [...this.jobs.values()].map(({ accounted: _accounted, ...record }) => ({
			...record,
			request: { ...record.request },
		}));
	}

	async budget(): Promise<ComputeBudgetSnapshot> {
		return {
			jobsSubmitted: this.jobsSubmitted,
			jobsCompleted: this.jobsCompleted,
			jobsFailed: this.jobsFailed,
			jobsCancelled: this.jobsCancelled,
			jobsRunning: this._runningJobCount(),
			totalDurationMs: this.totalDurationMs,
			estimatedDurationMs: this.estimatedDurationMs,
			gpuJobs: this.gpuJobs,
			limits: { ...this.limits },
			backends: await this.availableBackends(),
		};
	}

	/** Cancel all running jobs and remove disposable worktrees. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		for (const backend of this.backends.values()) {
			backend.dispose?.();
		}
		for (const record of this.jobs.values()) {
			if (record.status === "pending" || record.status === "running") {
				record.status = "cancelled";
				record.completedAt = new Date().toISOString();
			}
		}
		this._persist();
		this.disposed = true;
		for (const handle of this.worktreeHandles) {
			try {
				handle.cleanup();
			} catch {
				// Best-effort cleanup on shutdown.
			}
		}
		this.worktreeHandles.clear();
	}

	private async _trackCompletion(record: RuntimeJobRecord, backend: ComputeBackend): Promise<void> {
		try {
			const result = await backend.result(record.jobId);
			this._applyResult(record, result);
		} catch (error) {
			record.status = "failed";
			record.completedAt = new Date().toISOString();
			record.error = error instanceof Error ? error.message : String(error);
			this._persist();
		}
	}

	/** Apply a finished job's result exactly once to runtime accounting. */
	private _applyResult(record: RuntimeJobRecord, result: ComputeResult): void {
		record.result = result;
		record.status = result.status;
		record.completedAt = result.completedAt;
		record.error = result.error;
		if (record.accounted) {
			this._persist();
			return;
		}
		record.accounted = true;
		if (result.status === "completed") {
			this.jobsCompleted++;
		} else if (result.status === "cancelled") {
			this.jobsCancelled++;
		} else {
			this.jobsFailed++;
		}
		this.totalDurationMs += result.durationMs;
		this._persist();
	}

	private _runningJobCount(): number {
		let running = 0;
		for (const record of this.jobs.values()) {
			if (record.status === "pending" || record.status === "running") {
				running++;
			}
		}
		return running;
	}

	private _prepareWorktreeIsolation(): WorktreeHandle {
		if (!this.options.allowWorktreeIsolation) {
			throw new Error("worktree isolation is disabled in this compute runtime");
		}
		if (!isGitRepository(this.options.defaultCwd)) {
			throw new Error("worktree isolation requires a git repository working directory");
		}
		const worktreeRoot = join(this.options.stateDir ?? this.options.defaultCwd, "worktrees");
		return createWorktree({
			repoDir: this.options.defaultCwd,
			worktreeRootDir: worktreeRoot,
			signal: this.options.signal,
		});
	}

	private _registerBackends(): void {
		const backendStateDir = this.options.stateDir ?? join(this.options.defaultCwd, ".prometh-compute");
		this.backends.set(
			"local",
			new LocalComputeBackend({
				stateDir: backendStateDir,
				defaultTimeoutMs: this.limits.defaultTimeoutMs,
				maxStdoutBytes: this.limits.maxStdoutBytes,
				maxStderrBytes: this.limits.maxStderrBytes,
				signal: this.options.signal,
			}),
		);
		if (this.options.enableKaggle) {
			this.backends.set(
				"kaggle",
				new KaggleComputeBackend({
					stateDir: backendStateDir,
					signal: this.options.signal,
				}),
			);
		}
	}

	private _validateRequest(request: ComputeRequest): void {
		if (typeof request.command !== "string" || request.command.trim().length === 0) {
			throw new Error("compute.submit command must be a non-empty string");
		}
		if (request.command.length > 64_000) {
			throw new Error("compute.submit command is too long");
		}
		if (request.backend !== undefined && request.backend !== "local" && request.backend !== "kaggle") {
			throw new Error(`unknown compute backend "${String(request.backend)}"`);
		}
		if (request.isolation !== undefined && request.isolation !== "local" && request.isolation !== "worktree") {
			throw new Error(`unknown compute isolation "${String(request.isolation)}"`);
		}
		if (
			request.budgets?.timeoutMs !== undefined &&
			(!Number.isFinite(request.budgets.timeoutMs) || request.budgets.timeoutMs <= 0)
		) {
			throw new Error("compute.submit budgets.timeout_ms must be a positive number");
		}
	}

	private _requireJob(jobId: string): RuntimeJobRecord {
		const record = this.jobs.get(jobId);
		if (!record) {
			throw new Error(`unknown compute job "${jobId}"`);
		}
		return record;
	}

	private _persist(): void {
		if (!this.stateFile || this.disposed) {
			return;
		}
		const state: PersistedComputeState = {
			version: 1,
			jobs: [...this.jobs.values()].map((record) => ({
				jobId: record.jobId,
				backend: record.backend,
				status: record.status,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
				error: record.error,
				request: record.request,
				result: record.result,
			})),
		};
		const temp = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(state), "utf8");
			renameSync(temp, this.stateFile);
		} catch {
			// Persistence is best-effort; a failed write must not break the run.
		}
	}

	private _restore(): void {
		if (!this.stateFile) {
			return;
		}
		let raw: string;
		try {
			raw = readFileSync(this.stateFile, "utf8");
		} catch {
			return;
		}
		let parsed: PersistedComputeState;
		try {
			parsed = JSON.parse(raw) as PersistedComputeState;
		} catch {
			return;
		}
		for (const job of parsed.jobs ?? []) {
			if (typeof job.jobId !== "string" || !VALID_STATUSES.includes(job.status)) {
				continue;
			}
			// Jobs that were in flight when the host stopped cannot be resumed;
			// mark them failed so restored campaigns never wait on ghosts.
			const restoredStatus: ComputeJobStatus =
				job.status === "pending" || job.status === "running" ? "failed" : job.status;
			const record: RuntimeJobRecord = {
				jobId: job.jobId,
				backend: job.backend === "kaggle" ? "kaggle" : "local",
				status: restoredStatus,
				startedAt: job.startedAt ?? new Date().toISOString(),
				completedAt: restoredStatus === "failed" ? new Date().toISOString() : job.completedAt,
				error:
					restoredStatus === "failed"
						? (job.error ?? "compute runtime restarted while the job was in flight")
						: job.error,
				request: job.request ?? { command: "" },
				result: job.result,
				accounted: false,
			};
			this.jobs.set(record.jobId, record);
			this.jobsSubmitted++;
			if (record.result) {
				this._applyResult(record, record.result);
			} else if (restoredStatus === "completed") {
				this.jobsCompleted++;
				record.accounted = true;
			} else if (restoredStatus === "failed") {
				this.jobsFailed++;
				record.accounted = true;
			} else if (restoredStatus === "cancelled") {
				this.jobsCancelled++;
				record.accounted = true;
			}
		}
	}
}
