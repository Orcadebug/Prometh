/**
 * Compute runtime tests: local backend, budgets, result protocol,
 * persistence, and host-bridge validation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createComputeHostHandlers, parseComputeSubmitPayload } from "../src/core/compute/host-handlers.js";
import { parseStructuredResult, parseStructuredResultFile } from "../src/core/compute/result-protocol.js";
import { ComputeRuntime } from "../src/core/compute/runtime.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-compute-test-"));
}

describe("result protocol", () => {
	it("parses the prime_discovery_result convention", () => {
		const parsed = parseStructuredResult(
			'noise\n{"prime_discovery_result": {"metrics": {"accuracy": 0.948, "latency_ms": 109.4}, "valid": true, "notes": "ok"}}\ntrailing',
		);
		expect(parsed).toEqual({
			metrics: { accuracy: 0.948, latency_ms: 109.4 },
			valid: true,
			notes: "ok",
			predicted_metrics: undefined,
			extra: undefined,
		});
	});

	it("accepts a bare metrics object", () => {
		const parsed = parseStructuredResult('{"metrics": {"loss": 0.1}}');
		expect(parsed?.metrics).toEqual({ loss: 0.1 });
		expect(parsed?.valid).toBe(true);
	});

	it("rejects malformed output without throwing", () => {
		expect(parseStructuredResult("not json at all")).toBeUndefined();
		expect(parseStructuredResult('{"metrics": "nope"}')).toBeUndefined();
		expect(parseStructuredResult("")).toBeUndefined();
	});

	it("parses result files tolerating a missing file", () => {
		expect(parseStructuredResultFile("/nonexistent/nope.json")).toBeUndefined();
	});
});

describe("compute runtime", () => {
	let dir: string;
	let runtime: ComputeRuntime | undefined;

	beforeEach(() => {
		dir = tempDir();
		runtime = new ComputeRuntime({
			defaultCwd: dir,
			stateDir: join(dir, "state"),
			maxConcurrency: 2,
		});
	});

	afterEach(() => {
		runtime?.dispose();
		runtime = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("submits, completes, and returns results from the local backend", async () => {
		const submission = await runtime!.submit({
			command: 'echo "hello compute" && printf \'{"prime_discovery_result": {"metrics": {"runs": 1}}}\'',
		});
		expect(submission.jobId).toMatch(/^job_/);
		expect(submission.backend).toBe("local");

		const result = await runtime!.result(submission.jobId);
		expect(result.status).toBe("completed");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello compute");
		expect(result.metrics).toEqual({ runs: 1 });
		expect(result.structuredResult?.valid).toBe(true);
	});

	it("reports failed jobs with stderr", async () => {
		const submission = await runtime!.submit({ command: "echo oops >&2; exit 3" });
		const result = await runtime!.result(submission.jobId);
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("oops");
	});

	it("enforces per-job timeouts", async () => {
		const submission = await runtime!.submit({
			command: "sleep 5",
			budgets: { timeoutMs: 250 },
		});
		const result = await runtime!.result(submission.jobId);
		expect(result.status).toBe("failed");
		expect(result.timedOut).toBe(true);
	}, 10_000);

	it("cancels running jobs", async () => {
		const submission = await runtime!.submit({ command: "sleep 5" });
		await runtime!.cancel(submission.jobId);
		const result = await runtime!.result(submission.jobId);
		expect(result.status).toBe("cancelled");
	}, 10_000);

	it("truncates oversized output", async () => {
		const submission = await runtime!.submit({
			command: "python3 -c 'print(\"x\" * 100000)'",
			budgets: { maxStdoutBytes: 100 },
		});
		const result = await runtime!.result(submission.jobId);
		expect(result.stdout.length).toBeLessThanOrEqual(100);
		expect(result.stdoutTruncated).toBe(true);
	});

	it("bounds concurrency", async () => {
		const submissionA = await runtime!.submit({ command: "sleep 0.4" });
		const submissionB = await runtime!.submit({ command: "sleep 0.4" });
		await expect(runtime!.submit({ command: "sleep 0.1" })).rejects.toThrow(/concurrency bound/);
		await runtime!.result(submissionA.jobId);
		await runtime!.result(submissionB.jobId);
		const submissionC = await runtime!.submit({ command: "true" });
		expect((await runtime!.result(submissionC.jobId)).status).toBe("completed");
	}, 10_000);

	it("enforces the max jobs budget", async () => {
		const limited = new ComputeRuntime({
			defaultCwd: dir,
			stateDir: join(dir, "state-limited"),
			maxJobs: 2,
		});
		const a = await limited.submit({ command: "true" });
		await limited.result(a.jobId);
		await limited.submit({ command: "true" });
		await expect(limited.submit({ command: "true" })).rejects.toThrow(/job budget exhausted/);
		limited.dispose();
	});

	it("runs multiple jobs concurrently", async () => {
		const start = Date.now();
		const a = await runtime!.submit({ command: "sleep 0.3" });
		const b = await runtime!.submit({ command: "sleep 0.3" });
		const [resultA, resultB] = await Promise.all([runtime!.result(a.jobId), runtime!.result(b.jobId)]);
		expect(resultA.status).toBe("completed");
		expect(resultB.status).toBe("completed");
		expect(Date.now() - start).toBeLessThan(1000);
	}, 10_000);

	it("persists and restores finished job records", async () => {
		const submission = await runtime!.submit({ command: "echo persisted" });
		const firstResult = await runtime!.result(submission.jobId);
		runtime!.dispose();

		const restored = new ComputeRuntime({
			defaultCwd: dir,
			stateDir: join(dir, "state"),
		});
		const jobs = await restored.list();
		expect(jobs.map((job) => job.jobId)).toContain(submission.jobId);
		const job = jobs.find((entry) => entry.jobId === submission.jobId)!;
		expect(job.status).toBe("completed");
		expect(job.result?.stdout).toBe(firstResult.stdout);
		restored.dispose();
	});

	it("materializes structured files into the job working directory", async () => {
		const submission = await runtime!.submit({
			command: "python3 gen.py && cat out.json",
			files: [
				{
					path: "gen.py",
					content:
						'import json; json.dump({"prime_discovery_result": {"metrics": {"m": 7}}}, open("out.json", "w"))',
				},
			],
			resultFile: "out.json",
		});
		const result = await runtime!.result(submission.jobId);
		expect(result.status).toBe("completed");
		expect(result.metrics).toEqual({ m: 7 });
	});

	it("rejects invalid requests", async () => {
		await expect(runtime!.submit({ command: "" })).rejects.toThrow(/non-empty string/);
		await expect(runtime!.submit({ command: "true", backend: "gcp" as never })).rejects.toThrow(
			/unknown compute backend/,
		);
		await expect(runtime!.submit({ command: "true", isolation: "container" as never })).rejects.toThrow(
			/unknown compute isolation/,
		);
	});

	it("reports unavailable backends cleanly", async () => {
		expect(await runtime!.backendAvailable("local")).toBe(true);
		expect(await runtime!.backendAvailable("kaggle")).toBe(false);
	});

	it("tracks budget accounting", async () => {
		const a = await runtime!.submit({ command: "true", accelerator: "tpu", estimatedDurationMs: 5000 });
		await runtime!.result(a.jobId);
		const budget = await runtime!.budget();
		expect(budget.jobsSubmitted).toBe(1);
		expect(budget.jobsCompleted).toBe(1);
		expect(budget.gpuJobs).toBe(1);
		expect(budget.estimatedDurationMs).toBe(5000);
		expect(budget.totalDurationMs).toBeGreaterThanOrEqual(0);
		expect(budget.limits.maxConcurrency).toBe(2);
	});

	it("rejects worktree isolation without a git repository", async () => {
		const worktreeRuntime = new ComputeRuntime({
			defaultCwd: dir,
			stateDir: join(dir, "state-worktree"),
			allowWorktreeIsolation: true,
		});
		await expect(worktreeRuntime.submit({ command: "true", isolation: "worktree" })).rejects.toThrow(
			/worktree isolation requires a git repository/,
		);
		worktreeRuntime.dispose();
	});

	it("rejects worktree isolation when disabled", async () => {
		await expect(runtime!.submit({ command: "true", isolation: "worktree" })).rejects.toThrow(
			/worktree isolation is disabled/,
		);
	});

	it("runs worktree-isolated jobs in a disposable git checkout", async () => {
		const repoDir = tempDir();
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
			{
				cwd: repoDir,
			},
		);
		const worktreeRuntime = new ComputeRuntime({
			defaultCwd: repoDir,
			stateDir: join(repoDir, ".state"),
			allowWorktreeIsolation: true,
		});
		const submission = await worktreeRuntime.submit({
			command: "pwd",
			isolation: "worktree",
		});
		expect(submission.workDir).toBeDefined();
		expect(submission.workDir).toContain("worktrees");
		const result = await worktreeRuntime.result(submission.jobId);
		expect(result.status).toBe("completed");
		// The worktree checkout must exist during execution and be cleaned up on dispose.
		expect(realpathSync(result.stdout.trim())).toBe(realpathSync(submission.workDir!));
		worktreeRuntime.dispose();
		expect(existsSync(submission.workDir!)).toBe(false);
		rmSync(repoDir, { recursive: true, force: true });
	}, 15_000);
});

describe("compute host handlers", () => {
	it("validates submit payloads", () => {
		expect(() => parseComputeSubmitPayload({})).toThrow(/command/);
		expect(() => parseComputeSubmitPayload({ command: "true", backend: "gcp" })).toThrow(/backend/);
		expect(() => parseComputeSubmitPayload({ command: "true", timeout_ms: -1 })).toThrow(/timeout/);
		expect(() => parseComputeSubmitPayload({ command: "true", files: [{ path: "a.py", content: 5 }] })).toThrow(
			/files\[0\]/,
		);
		const parsed = parseComputeSubmitPayload({
			command: "python a.py",
			backend: "local",
			isolation: "worktree",
			timeout_ms: 5000,
			estimated_duration_ms: 1000,
			result_file: "out.json",
			files: [{ path: "a.py", content: "print(1)" }],
			metadata: { hypothesis: "x" },
		});
		expect(parsed.command).toBe("python a.py");
		expect(parsed.backend).toBe("local");
		expect(parsed.isolation).toBe("worktree");
		expect(parsed.budgets?.timeoutMs).toBe(5000);
		expect(parsed.resultFile).toBe("out.json");
		expect(parsed.files).toHaveLength(1);
		expect(parsed.metadata).toEqual({ hypothesis: "x" });
	});

	it("rejects invalid handler payloads", async () => {
		const runtime = new ComputeRuntime({ defaultCwd: tmpdir() });
		const handlers = createComputeHostHandlers(runtime);
		await expect(handlers["compute.status"]!({})).rejects.toThrow(/job_id/);
		await expect(handlers["compute.result"]!({ job_id: "nope" })).rejects.toThrow(/unknown compute job/);
		runtime.dispose();
	});
});
