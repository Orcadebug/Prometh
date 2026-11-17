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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStructuredResult, parseStructuredResultFile } from "../result-protocol.js";
import type { ComputeJobStatusSnapshot, ComputeRequest, ComputeResult, ComputeSubmission } from "../types.js";
import type { ComputeBackend } from "./base.js";

interface KaggleJob {
	id: string;
	slug: string;
	remoteRef: string;
	request: ComputeRequest;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	startedAt: string;
	completedAt?: string;
	error?: string;
	outputDir: string;
	completion: Promise<void>;
	resolveCompletion: () => void;
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
		const remoteRef = request.metadata?.kaggle_kernel_ref;
		if (typeof remoteRef !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(remoteRef)) {
			throw new Error(
				'kaggle jobs require metadata.kaggle_kernel_ref in the form "owner/kernel-slug"; create the kernel once in Kaggle or choose an unused slug under your account',
			);
		}
		let resolveCompletion = () => {};
		const completion = new Promise<void>((resolve) => {
			resolveCompletion = resolve;
		});
		const job: KaggleJob = {
			id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
			slug: remoteRef.split("/")[1]!,
			remoteRef,
			request,
			status: "pending",
			startedAt: new Date().toISOString(),
			outputDir: join(this.options.stateDir, "kaggle", `output-${randomUUID().replaceAll("-", "").slice(0, 12)}`),
			completion,
			resolveCompletion,
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
				id: job.remoteRef,
				title: job.request.label ?? "prometh compute job",
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
				const status = runCli(cliPath, ["kernels", "status", job.remoteRef]);
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
		} finally {
			job.resolveCompletion();
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
			await job.completion;
		}
		let artifacts: ComputeResult["artifacts"] = [];
		let stdout = "";
		let structuredResult: ComputeResult["structuredResult"];
		if (job.status === "completed") {
			const output = runCli(this.options.cliPath ?? "kaggle", [
				"kernels",
				"output",
				job.remoteRef,
				"-p",
				job.outputDir,
			]);
			if (!output.ok) {
				job.status = "failed";
				job.error = `kaggle kernels output failed: ${output.stderr.trim().slice(0, 400)}`;
			} else {
				artifacts = this._collectArtifacts(job.outputDir);
				const resultPath = job.request.resultFile ? join(job.outputDir, job.request.resultFile) : undefined;
				structuredResult = resultPath
					? parseStructuredResultFile(resultPath)
					: this._findStructuredResult(job.outputDir);
				stdout = output.stdout;
			}
		}
		return {
			status: job.status,
			exitCode: job.status === "completed" ? 0 : 1,
			stdout,
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			timedOut: false,
			error: job.error,
			structuredResult,
			metrics: structuredResult?.metrics ?? {},
			workDir: job.outputDir,
			artifacts,
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
			const cancelled = runCli(this.options.cliPath ?? "kaggle", ["kernels", "cancel", job.remoteRef]);
			job.status = "cancelled";
			job.error = "cancelled";
			if (!cancelled.ok) job.error = `kaggle kernels cancel failed: ${cancelled.stderr.trim().slice(0, 400)}`;
			job.completedAt = new Date().toISOString();
			job.resolveCompletion();
		}
	}

	private _collectArtifacts(dir: string): ComputeResult["artifacts"] {
		if (!existsSync(dir)) return [];
		const artifacts: ComputeResult["artifacts"] = [];
		for (const entry of readdirSync(dir, { recursive: true })) {
			const path = join(dir, String(entry));
			if (!statSync(path).isFile()) continue;
			artifacts.push({ kind: path.endsWith(".json") ? "metrics" : "checkpoint", path });
		}
		return artifacts;
	}

	private _findStructuredResult(dir: string): ComputeResult["structuredResult"] {
		for (const artifact of this._collectArtifacts(dir)) {
			if (artifact.path.endsWith(".json")) {
				const parsed =
					parseStructuredResultFile(artifact.path) ?? parseStructuredResult(readFileSync(artifact.path, "utf8"));
				if (parsed) return parsed;
			}
		}
		return undefined;
	}
}
