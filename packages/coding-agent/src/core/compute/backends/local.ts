/**
 * Bounded local compute backend.
 *
 * Executes shell commands as detached child processes with enforced
 * wall-clock timeouts, output-size caps, and cancellation. Jobs run in a
 * dedicated per-job working directory. Local execution inherits the host
 * process permissions — this is not a security sandbox.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { waitForChildProcess } from "../../../utils/child-process.js";
import {
	killProcessTree,
	sanitizeBinaryOutput,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../../utils/shell.js";
import { parseStructuredResult, parseStructuredResultFile } from "../result-protocol.js";
import type {
	ComputeJobStatus,
	ComputeJobStatusSnapshot,
	ComputeRequest,
	ComputeResult,
	ComputeSubmission,
} from "../types.js";
import type { ComputeBackend } from "./base.js";

export interface LocalBackendOptions {
	/** Root directory under which job working directories are created. */
	stateDir: string;
	/** Default per-job timeout. */
	defaultTimeoutMs?: number;
	/** Default maximum captured stdout bytes. */
	maxStdoutBytes?: number;
	/** Default maximum captured stderr bytes. */
	maxStderrBytes?: number;
	/** Optional signal aborting all jobs (session shutdown). */
	signal?: AbortSignal;
}

interface LocalJob {
	id: string;
	request: ComputeRequest;
	status: ComputeJobStatus;
	startedAt: string;
	completedAt?: string;
	error?: string;
	workDir?: string;
	abort?: AbortController;
	result?: ComputeResult;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	exitCode: number | null;
	timedOut: boolean;
}

export class LocalComputeBackend implements ComputeBackend {
	readonly id = "local";
	readonly label = "Local subprocess execution";

	private readonly jobs = new Map<string, LocalJob>();
	private readonly defaultTimeoutMs: number;
	private readonly maxStdoutBytes: number;
	private readonly maxStderrBytes: number;

	constructor(private readonly options: LocalBackendOptions) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 20 * 60 * 1000;
		this.maxStdoutBytes = options.maxStdoutBytes ?? 256 * 1024;
		this.maxStderrBytes = options.maxStderrBytes ?? 256 * 1024;
	}

	async available(): Promise<boolean> {
		return true;
	}

	async submit(request: ComputeRequest): Promise<ComputeSubmission> {
		const job: LocalJob = {
			id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
			request,
			status: "pending",
			startedAt: new Date().toISOString(),
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			exitCode: null,
			timedOut: false,
		};
		this.jobs.set(job.id, job);
		void this._start(job);
		return {
			jobId: job.id,
			backend: "local",
			status: job.status,
			startedAt: job.startedAt,
			workDir: job.workDir,
		};
	}

	async status(jobId: string): Promise<ComputeJobStatusSnapshot> {
		return this._snapshot(this._requireJob(jobId));
	}

	async result(jobId: string): Promise<ComputeResult> {
		const job = this._requireJob(jobId);
		if (job.result) {
			return job.result;
		}
		// Wait for the job to reach a terminal state. Completion is signalled
		// by the finish() path in _start, which calls _finalize.
		for (;;) {
			if (job.result) {
				return job.result;
			}
			if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
				return this._finalize(job);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	async cancel(jobId: string): Promise<void> {
		const job = this._requireJob(jobId);
		if (job.status !== "pending" && job.status !== "running") {
			return;
		}
		job.abort?.abort();
		job.status = "cancelled";
		job.completedAt = new Date().toISOString();
		void this._finalize(job);
	}

	/** Kill all running children and mark them cancelled. */
	dispose(): void {
		for (const job of this.jobs.values()) {
			if (job.status === "pending" || job.status === "running") {
				job.abort?.abort();
				job.status = "cancelled";
				job.completedAt = new Date().toISOString();
			}
		}
	}

	private async _start(job: LocalJob): Promise<void> {
		try {
			if (this.options.signal?.aborted) {
				throw new Error("compute runtime is shutting down");
			}
			job.workDir = this._prepareWorkDir(job);
			job.status = "running";

			const abort = new AbortController();
			job.abort = abort;
			const onRuntimeAbort = () => abort.abort();
			this.options.signal?.addEventListener("abort", onRuntimeAbort, { once: true });

			const timeoutMs = job.request.budgets?.timeoutMs ?? this.defaultTimeoutMs;
			const maxStdoutBytes = job.request.budgets?.maxStdoutBytes ?? this.maxStdoutBytes;
			const maxStderrBytes = job.request.budgets?.maxStderrBytes ?? this.maxStderrBytes;

			const child = spawn(job.request.command, {
				cwd: job.workDir,
				shell: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PRIME_COMPUTE_JOB_ID: job.id,
					PRIME_COMPUTE_WORK_DIR: job.workDir,
				},
			});
			if (child.pid) {
				trackDetachedChildPid(child.pid);
			}
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				const remaining = maxStdoutBytes - job.stdout.length;
				if (remaining > 0) {
					job.stdout += chunk.slice(0, remaining);
				}
				job.stdoutTruncated ||= chunk.length > remaining;
			});
			child.stderr?.on("data", (chunk: string) => {
				const remaining = maxStderrBytes - job.stderr.length;
				if (remaining > 0) {
					job.stderr += chunk.slice(0, remaining);
				}
				job.stderrTruncated ||= chunk.length > remaining;
			});

			let settled = false;
			let timedOutFlag = false;
			const finish = (error?: string) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
				abort.signal.removeEventListener("abort", onAbort);
				this.options.signal?.removeEventListener("abort", onRuntimeAbort);
				if (child.pid) {
					untrackDetachedChildPid(child.pid);
				}
				job.timedOut = timedOutFlag;
				job.exitCode = child.exitCode;
				job.error = error;
				job.completedAt = new Date().toISOString();
				if (job.status !== "cancelled") {
					job.status = timedOutFlag || error || child.exitCode !== 0 ? "failed" : "completed";
				}
				void this._finalize(job);
			};

			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};
			abort.signal.addEventListener("abort", onAbort, { once: true });
			if (abort.signal.aborted) {
				onAbort();
			}

			let timer: NodeJS.Timeout | undefined;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					timedOutFlag = true;
					if (child.pid) {
						killProcessTree(child.pid);
					}
				}, timeoutMs);
			}

			void waitForChildProcess(child).then(
				() => finish(),
				(err: Error) => finish(err.message),
			);
		} catch (error) {
			job.error = error instanceof Error ? error.message : String(error);
			job.status = "failed";
			job.completedAt = new Date().toISOString();
			void this._finalize(job);
		}
	}

	private _prepareWorkDir(job: LocalJob): string {
		// Worktree isolation: the runtime creates a disposable git worktree and
		// passes its path through request metadata. The job runs inside it.
		const worktreePath = job.request.metadata?.worktreePath;
		const workDir = typeof worktreePath === "string" ? worktreePath : join(this.options.stateDir, "jobs", job.id);
		mkdirSync(workDir, { recursive: true });
		const root = resolve(workDir);
		for (const file of job.request.files ?? []) {
			const target = resolve(workDir, file.path);
			if (target !== root && !target.startsWith(`${root}${sep}`)) {
				throw new Error(`compute job file path escapes the working directory: ${file.path}`);
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, file.content, "utf8");
		}
		return workDir;
	}

	private async _finalize(job: LocalJob): Promise<ComputeResult> {
		if (job.result) {
			return job.result;
		}
		const completedAt = job.completedAt ?? new Date().toISOString();
		const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(job.startedAt));
		const stdout = sanitizeBinaryOutput(job.stdout);
		const stderr = sanitizeBinaryOutput(job.stderr);
		const structuredResult = job.request.resultFile
			? parseStructuredResultFile(join(job.workDir ?? "", job.request.resultFile))
			: (parseStructuredResult(stdout) ?? parseStructuredResult(stderr));
		const result: ComputeResult = {
			status: job.status,
			exitCode: job.exitCode,
			stdout,
			stderr,
			stdoutTruncated: job.stdoutTruncated,
			stderrTruncated: job.stderrTruncated,
			timedOut: job.timedOut,
			error: job.error,
			structuredResult,
			metrics: structuredResult?.metrics ?? {},
			workDir: job.workDir ?? "",
			artifacts: [],
			startedAt: job.startedAt,
			completedAt,
			durationMs,
		};
		job.result = result;
		return result;
	}

	private _snapshot(job: LocalJob): ComputeJobStatusSnapshot {
		return {
			jobId: job.id,
			backend: "local",
			status: job.status,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
			error: job.error,
		};
	}

	private _requireJob(jobId: string): LocalJob {
		const job = this.jobs.get(jobId);
		if (!job) {
			throw new Error(`unknown compute job "${jobId}"`);
		}
		return job;
	}
}
