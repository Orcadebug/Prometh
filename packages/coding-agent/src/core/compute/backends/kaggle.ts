/**
 * Optional Kaggle backend adapter around the official Kaggle CLI.
 *
 * The backend is only usable when the `kaggle` CLI is installed and
 * authenticated. `available()` probes the CLI without reading or logging
 * credentials; when unavailable, every other call fails with a descriptive
 * error. No credentials are ever hard-coded or logged.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputeJobStatusSnapshot, ComputeRequest, ComputeResult, ComputeSubmission } from "../types.js";
import type { ComputeBackend } from "./base.js";

interface KaggleJob {
	id: string;
	slug: string;
	request: ComputeRequest;
	status: "pending" | "running" | "completed" | "failed";
	startedAt: string;
	completedAt?: string;
	error?: string;
}

export interface KaggleBackendOptions {
	/** Directory for kernel-metadata staging. */
	stateDir: string;
	/** Optional explicit path to the kaggle CLI executable. */
	cliPath?: string;
	/** Optional signal aborting the backend. */
	signal?: AbortSignal;
}

function runCli(cliPath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync(cliPath, args, {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, KAGGLE_CONFIG_DIR: process.env.KAGGLE_CONFIG_DIR ?? "" },
	});
	return {
		ok: result.status === 0 && !result.error,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function checkCli(cliPath: string): boolean {
	try {
		return runCli(cliPath, ["--version"]).ok;
	} catch {
		return false;
	}
}

export class KaggleComputeBackend implements ComputeBackend {
	readonly id = "kaggle";
	readonly label = "Kaggle kernel execution (via kaggle CLI)";

	private readonly jobs = new Map<string, KaggleJob>();
	private availability: boolean | undefined;

	constructor(private readonly options: KaggleBackendOptions) {}

	async available(): Promise<boolean> {
		if (this.availability !== undefined) {
			return this.availability;
		}
		this.availability = checkCli(this.options.cliPath ?? "kaggle");
		return this.availability;
	}

	private requireAvailable(): void {
		if (!checkCli(this.options.cliPath ?? "kaggle")) {
			throw new Error(
				"kaggle backend unavailable: the kaggle CLI is not installed or authenticated. Install and authenticate the official Kaggle CLI to use remote Kaggle kernels.",
			);
		}
	}

	async submit(request: ComputeRequest): Promise<ComputeSubmission> {
		this.requireAvailable();
		if (this.options.signal?.aborted) {
			throw new Error("compute runtime is shutting down");
		}
		if (request.files && request.files.length > 100) {
			throw new Error("kaggle backend supports at most 100 dataset files per job");
		}
		const job: KaggleJob = {
			id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
			slug: `prime-agent-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
			request,
			status: "pending",
			startedAt: new Date().toISOString(),
		};
		this.jobs.set(job.id, job);
		void this._push(job);
		return { jobId: job.id, backend: "kaggle", status: job.status, startedAt: job.startedAt };
	}

	private async _push(job: KaggleJob): Promise<void> {
		const cliPath = this.options.cliPath ?? "kaggle";
		const stagingDir = join(this.options.stateDir, "kaggle", job.id);
		try {
			mkdirSync(stagingDir, { recursive: true });
			const datasetSources = job.request.metadata?.kaggle_dataset_sources;
			const metadata: Record<string, unknown> = {
				id: job.slug,
				title: job.request.label ?? "prime-agent compute job",
				code_file: "run.py",
				language: "python",
				kernel_type: "script",
				is_private: true,
				enable_gpu: Boolean(job.request.accelerator),
				enable_internet: true,
			};
			if (Array.isArray(datasetSources)) {
				metadata.dataset_sources = datasetSources;
			}
			writeFileSync(join(stagingDir, "kernel-metadata.json"), JSON.stringify(metadata, null, 2));
			writeFileSync(join(stagingDir, "run.py"), job.request.command);
			job.status = "running";
			const push = runCli(cliPath, ["kernels", "push", "-p", stagingDir, "-m", "kernel-metadata.json"]);
			if (!push.ok) {
				throw new Error(`kaggle kernels push failed: ${push.stderr.trim().slice(0, 400)}`);
			}
			// Poll kernel status until it exits. Status polling is bounded by the
			// runtime-level timeout through the abort signal handled by callers.
			for (;;) {
				if (this.options.signal?.aborted) {
					job.status = "failed";
					job.error = "compute runtime is shutting down";
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 5_000));
				const status = runCli(cliPath, ["kernels", "status", job.slug]);
				if (!status.ok) {
					job.status = "failed";
					job.error = `kaggle kernels status failed: ${status.stderr.trim().slice(0, 400)}`;
					break;
				}
				if (status.stdout.includes('has status "complete"')) {
					job.status = "completed";
					job.completedAt = new Date().toISOString();
					break;
				}
				if (status.stdout.includes('has status "error"')) {
					job.status = "failed";
					job.error = "kaggle kernel errored";
					job.completedAt = new Date().toISOString();
					break;
				}
			}
		} catch (error) {
			job.status = "failed";
			job.error = error instanceof Error ? error.message : String(error);
			job.completedAt = new Date().toISOString();
		}
	}

	async status(jobId: string): Promise<ComputeJobStatusSnapshot> {
		const job = this.jobs.get(jobId);
		if (!job) {
			throw new Error(`unknown compute job "${jobId}"`);
		}
		return {
			jobId: job.id,
			backend: "kaggle",
			status: job.status,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
			error: job.error,
		};
	}

	async result(jobId: string): Promise<ComputeResult> {
		const job = this.jobs.get(jobId);
		if (!job) {
			throw new Error(`unknown compute job "${jobId}"`);
		}
		if (job.status === "pending" || job.status === "running") {
			throw new Error(`job ${jobId} has not finished`);
		}
		// Output download is intentionally not implemented in v1; result
		// retrieval requires the kaggle CLI output download which needs an
		// authenticated session and is deferred to a follow-up.
		return {
			status: job.status,
			exitCode: job.status === "completed" ? 0 : 1,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			timedOut: false,
			error: job.error,
			metrics: {},
			workDir: "",
			artifacts: [],
			startedAt: job.startedAt,
			completedAt: job.completedAt ?? new Date().toISOString(),
			durationMs: 0,
		};
	}

	async cancel(jobId: string): Promise<void> {
		const job = this.jobs.get(jobId);
		if (!job) {
			throw new Error(`unknown compute job "${jobId}"`);
		}
		if (job.status === "pending" || job.status === "running") {
			job.status = "failed";
			job.error = "cancelled";
			job.completedAt = new Date().toISOString();
		}
	}
}
