/**
 * Kernel-level test for the compute and discovery Python skills over the
 * real host bridge. Verifies Python-side validation, payload shapes, and
 * host error propagation.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledSkill(name: string): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), name);
	return {
		name,
		importName: name,
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("compute and discovery skills over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-discovery-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips compute.submit through a live kernel with Python validation", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("compute")],
			hostHandlers: {
				"compute.submit": async (payload) => {
					requests.push({ type: "compute.submit", payload });
					return {
						job: {
							jobId: "job_test",
							backend: "local",
							status: "pending",
							startedAt: new Date().toISOString(),
						},
					};
				},
				"compute.budget": async () => ({
					budget: { jobsSubmitted: 1, jobsCompleted: 0, jobsFailed: 0, jobsCancelled: 0, jobsRunning: 1 },
				}),
			},
		});

		const manager = await provisioner.ensure();
		const created = await manager.execute(`
import json
_submitted = await compute.submit("python experiment.py --variant A", timeout_ms=60000, label="variant A", metadata={"hypothesis": "faster"})
print(json.dumps(_submitted, sort_keys=True))
`);
		expect(created.status).toBe("ok");
		expect(JSON.parse(created.stdout.trim())).toEqual({
			job: { jobId: "job_test", backend: "local", status: "pending", startedAt: expect.any(String) },
		});
		expect(requests[0].payload).toMatchObject({
			type: "compute.submit",
			command: "python experiment.py --variant A",
			timeout_ms: 60000,
			label: "variant A",
			backend: "local",
			isolation: "local",
		});

		const validation = await manager.execute(`
try:
    await compute.submit("true", timeout_ms=-5)
except ValueError as error:
    print(f"ValueError: {error}")
`);
		expect(validation.status).toBe("ok");
		expect(validation.stdout.trim()).toBe("ValueError: timeout_ms must be a positive integer");
	});

	it("round-trips discovery.create and discovery.set_baseline with Python validation", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("discovery")],
			hostHandlers: {
				"discovery.create": async (payload) => {
					requests.push({ type: "discovery.create", payload });
					return {
						campaign: {
							id: "dc_test",
							objective: payload.objective,
							status: "active",
							experiences: [],
							elites: [],
							novelty_archive: [],
							surprise_archive: [],
							failure_archive: [],
						},
					};
				},
				"discovery.set_baseline": async (payload) => {
					requests.push({ type: "discovery.set_baseline", payload });
					return { campaign: { id: "dc_test", status: "active" } };
				},
			},
		});

		const manager = await provisioner.ensure();
		const created = await manager.execute(`
import json
_created = await discovery.create("reduce latency", budgets={"max_compute_jobs": 200})
print(json.dumps(_created, sort_keys=True))
`);
		expect(created.status).toBe("ok");
		expect(requests[0].payload).toMatchObject({
			type: "discovery.create",
			objective: "reduce latency",
			budgets: { max_compute_jobs: 200 },
		});

		const baseline = await manager.execute(`
await discovery.set_baseline("dc_test", metrics={"latency_ms": 142, "accuracy": 0.934})
print("baseline ok")
`);
		expect(baseline.status).toBe("ok");
		expect(baseline.stdout.trim()).toBe("baseline ok");
		expect(requests[1].payload).toMatchObject({
			type: "discovery.set_baseline",
			campaign_id: "dc_test",
			metrics: { latency_ms: 142, accuracy: 0.934 },
		});

		const validation = await manager.execute(`
try:
    await discovery.set_baseline("dc_test", metrics={})
except ValueError as error:
    print(f"ValueError: {error}")
`);
		expect(validation.status).toBe("ok");
		expect(validation.stdout.trim()).toBe("ValueError: metrics must be a non-empty dict");
	});

	it("surfaces host errors as Python exceptions", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("compute"), bundledSkill("discovery")],
			hostHandlers: {
				"discovery.status": async () => {
					throw new Error("unknown discovery campaign");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await discovery.status("dc_missing")
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe("RuntimeError: unknown discovery campaign");
	});
});
