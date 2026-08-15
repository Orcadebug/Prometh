/**
 * Discovery engine tests: campaigns, experiences, lineage, archives, budgets,
 * baselines, replication, summaries, persistence, and host-bridge validation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputeRuntime } from "../src/core/compute/runtime.js";
import { DiscoveryEngine } from "../src/core/discovery/engine.js";
import { createDiscoveryHostHandlers } from "../src/core/discovery/host-handlers.js";
import { assignArchives, noveltyScore, numericSurprise, objectiveScore } from "../src/core/discovery/scoring.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-discovery-test-"));
}

function metricsCommand(metrics: Record<string, unknown>): string {
	return `printf '%s' '${JSON.stringify({ prime_discovery_result: { metrics } })}'`;
}

describe("scoring", () => {
	it("computes directional objective scores against a reference", () => {
		const score = objectiveScore(
			{ latency_ms: 100, accuracy: 0.95 },
			{ latency_ms: 142, accuracy: 0.934 },
			{ objectiveMetric: "latency_ms", directions: { latency_ms: "minimize", accuracy: "maximize" } },
		);
		expect(score).toBeGreaterThan(0.5);
		const worse = objectiveScore(
			{ latency_ms: 200, accuracy: 0.9 },
			{ latency_ms: 142, accuracy: 0.934 },
			{ objectiveMetric: "latency_ms", directions: { latency_ms: "minimize", accuracy: "maximize" } },
		);
		expect(worse).toBeLessThan(0.5);
	});

	it("computes numeric surprise from predicted vs observed", () => {
		const surprise = numericSurprise({
			predicted: { latency_ms: 120 },
			observed: { latency_ms: 300 },
		});
		expect(surprise).toBeGreaterThan(0.5);
		const calm = numericSurprise({ predicted: { latency_ms: 120 }, observed: { latency_ms: 121 } });
		expect(calm).toBeLessThan(0.2);
	});

	it("computes novelty from parameter distance", () => {
		const novel = noveltyScore({
			params: { lr: 0.5, depth: 10 },
			known: [{ params: { lr: 0.001, depth: 2 } }],
		});
		const similar = noveltyScore({
			params: { lr: 0.001, depth: 2 },
			known: [{ params: { lr: 0.001, depth: 2 } }],
		});
		expect(novel).toBeGreaterThan(similar);
	});

	it("assigns archives additively without deleting losers", () => {
		const archives = assignArchives({
			objective: 0.9,
			novelty: 0.4,
			surprise: 0.1,
			valid: true,
			bestSoFar: true,
			novelestSoFar: false,
			mostSurprisingSoFar: false,
			informativeFailure: false,
		});
		expect(archives).toEqual(["elite"]);
		const failed = assignArchives({
			objective: 0.1,
			novelty: 0.3,
			surprise: 0.8,
			valid: false,
			bestSoFar: false,
			novelestSoFar: false,
			mostSurprisingSoFar: true,
			informativeFailure: true,
		});
		expect(failed).toContain("surprise");
		expect(failed).toContain("failure");
	});
});

describe("discovery engine", () => {
	let dir: string;
	let compute: ComputeRuntime | undefined;
	let engine: DiscoveryEngine | undefined;

	beforeEach(() => {
		dir = tempDir();
		compute = new ComputeRuntime({ defaultCwd: dir, stateDir: join(dir, "compute-state") });
		engine = new DiscoveryEngine({
			compute,
			stateDir: join(dir, "session-artifacts"),
			scoring: {
				objectiveMetric: "latency_ms",
				directions: { latency_ms: "minimize", accuracy: "maximize" },
			},
		});
	});

	afterEach(() => {
		compute?.dispose();
		compute = undefined;
		engine = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates and lists campaigns", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		expect(campaign.id).toMatch(/^dc_/);
		expect(campaign.status).toBe("active");
		const campaigns = await engine!.listCampaigns();
		expect(campaigns).toHaveLength(1);
	});

	it("records experiences with lineage and executes them", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		await engine!.setBaseline(campaign.id, { latency_ms: 142, accuracy: 0.934 });
		const parent = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 130, accuracy: 0.93 }) },
			hypothesis: "variant A",
		});
		expect(parent.status).toBe("completed");
		expect(parent.metrics).toEqual({ latency_ms: 130, accuracy: 0.93 });

		const child = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 110, accuracy: 0.94 }), params: { lr: 0.01 } },
			hypothesis: "variant B",
			parentExperienceIds: [parent.id],
			operators: ["mutate"],
			generation: 1,
			reasonSelected: "best so far",
		});
		expect(child.parentExperienceIds).toEqual([parent.id]);
		expect(child.operators).toEqual(["mutate"]);
		expect(child.generation).toBe(1);

		const experiences = await engine!.listExperiences(campaign.id);
		expect(experiences).toHaveLength(2);
	});

	it("maintains archives: elites, novelty, surprise, failures", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		await engine!.setBaseline(campaign.id, { latency_ms: 142 });

		// Mediocre first candidate
		const first = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 140 }) },
		});
		expect(first.archives).toContain("elite");

		// Better candidate becomes the new elite
		const better = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 100 }), params: { depth: 2 } },
		});
		expect(better.archives).toContain("elite");

		// A surprising failure is preserved, not deleted
		const surprise = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: "echo boom >&2; exit 1" },
			predictedMetrics: { latency_ms: 90 },
			hypothesis: "aggressive inlining should win",
		});
		expect(surprise.status).toBe("failed");

		const archives = await engine!.archives(campaign.id);
		expect(archives.elite.length).toBeGreaterThan(0);
		const state = await engine!.getCampaign(campaign.id);
		expect(state.experiences).toHaveLength(3);
	});

	it("enforces budgets and marks campaigns exhausted", async () => {
		const campaign = await engine!.createCampaign({
			objective: "reduce latency",
			budgets: { maxExperiences: 2, maxComputeJobs: 10 },
		});
		await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 100 }) },
		});
		await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 99 }) },
		});
		await expect(
			engine!.recordExperience({
				campaignId: campaign.id,
				intervention: { command: metricsCommand({ latency_ms: 98 }) },
			}),
		).rejects.toThrow(/budget/);
		const state = await engine!.getCampaign(campaign.id);
		expect(state.status).toBe("budget_exhausted");
	});

	it("supports baselines with relative changes in summaries", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		await engine!.setBaseline(campaign.id, { latency_ms: 142 });
		await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 100 }) },
		});
		const summary = await engine!.summarize(campaign.id);
		expect(summary.best?.change.latency_ms).toBeLessThan(0);
		expect(summary.baseline?.metrics).toEqual({ latency_ms: 142 });
	});

	it("replicates winners across seeds and records aggregates", async () => {
		const campaign = await engine!.createCampaign({
			objective: "reduce latency",
			budgets: { maxComputeJobs: 10 },
		});
		const winner = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: "true" },
		});
		const replicated = await engine!.replicate({
			campaignId: campaign.id,
			experienceId: winner.id,
			seeds: [1, 2, 3],
			commandTemplate:
				'printf \'{"prime_discovery_result": {"metrics": {"latency_ms": __SEED__}}}\' | sed "s/__SEED__/{seed}/g"',
		});
		expect(replicated.replications?.successfulRuns).toBe(3);
		expect(replicated.replications?.aggregate.latency_ms_mean).toBeDefined();
		expect(replicated.replications?.aggregate.latency_ms_min).toBeDefined();
		expect(replicated.replications?.aggregate.latency_ms_max).toBeDefined();
	});

	it("persists and restores campaigns with experiences", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		const experience = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 100 }) },
		});
		const summary = await engine!.summarize(campaign.id);
		expect(summary.experiences).toBe(1);

		const restoredCompute = new ComputeRuntime({ defaultCwd: dir, stateDir: join(dir, "compute-state") });
		const restored = new DiscoveryEngine({
			compute: restoredCompute,
			stateDir: join(dir, "session-artifacts"),
		});
		const campaigns = await restored.listCampaigns();
		expect(campaigns).toHaveLength(1);
		expect(campaigns[0].id).toBe(campaign.id);
		const experiences = await restored.listExperiences(campaign.id);
		expect(experiences.map((entry) => entry.id)).toContain(experience.id);
		restoredCompute.dispose();
	});

	it("completes campaigns only through complete()", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 100 }) },
		});
		const summary = await engine!.complete(campaign.id);
		expect(summary.campaignId).toBe(campaign.id);
		const state = await engine!.getCampaign(campaign.id);
		expect(state.status).toBe("completed");
		await expect(
			engine!.recordExperience({
				campaignId: campaign.id,
				intervention: { command: metricsCommand({ latency_ms: 99 }) },
			}),
		).rejects.toThrow(/not active/);
	});

	it("supports pause and resume", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		const paused = await engine!.pauseCampaign(campaign.id);
		expect(paused.status).toBe("paused");
		await expect(
			engine!.recordExperience({
				campaignId: campaign.id,
				intervention: { command: metricsCommand({ latency_ms: 100 }) },
			}),
		).rejects.toThrow(/not active/);
		const resumed = await engine!.resumeCampaign(campaign.id);
		expect(resumed.status).toBe("active");
	});

	it("builds refinement provenance for validated discoveries", async () => {
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		const experience = await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 100 }) },
		});
		const provenance = engine!.buildRefinementProvenance({
			campaignId: campaign.id,
			recommendation: "persist profiling strategy",
			experienceIds: [experience.id],
			validation: "passed",
		});
		expect(provenance).toMatchObject({
			source: "discovery",
			campaign_id: campaign.id,
			experience_ids: [experience.id],
			validation: "passed",
		});
	});

	it("exposes continuable work only within budget", async () => {
		const campaign = await engine!.createCampaign({
			objective: "reduce latency",
			budgets: { maxExperiences: 1 },
		});
		expect(engine!.hasContinuableWork()).toBe(true);
		await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: metricsCommand({ latency_ms: 100 }) },
		});
		expect(engine!.hasContinuableWork()).toBe(false);
	});
});

describe("discovery host handlers", () => {
	let dir: string;
	let compute: ComputeRuntime;
	let engine: DiscoveryEngine;

	beforeEach(() => {
		dir = tempDir();
		compute = new ComputeRuntime({ defaultCwd: dir, stateDir: join(dir, "compute-state") });
		engine = new DiscoveryEngine({ compute, stateDir: join(dir, "session-artifacts") });
	});

	afterEach(() => {
		compute.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("validates create payloads", async () => {
		const handlers = createDiscoveryHostHandlers(engine);
		await expect(handlers["discovery.create"]!({})).rejects.toThrow(/objective/);
		await expect(handlers["discovery.create"]!({ objective: "x", budgets: { max_experiences: -1 } })).rejects.toThrow(
			/max_experiences/,
		);
	});

	it("rejects unknown campaign ids", async () => {
		const handlers = createDiscoveryHostHandlers(engine);
		await expect(handlers["discovery.status"]!({ campaign_id: "dc_nope" })).rejects.toThrow(/unknown/);
		await expect(handlers["discovery.experiences"]!({ campaign_id: "" })).rejects.toThrow(/campaign_id/);
	});

	it("round-trips create, add_candidate, and summarize", async () => {
		const handlers = createDiscoveryHostHandlers(engine);
		const created = await handlers["discovery.create"]!({ objective: "find fast code" });
		const campaignId = (created.campaign as { id: string }).id;
		const added = await handlers["discovery.add_candidate"]!({
			campaign_id: campaignId,
			intervention: { command: metricsCommand({ latency_ms: 50 }) },
			hypothesis: "variant",
		});
		expect((added.experience as { status: string }).status).toBe("completed");
		const summary = await handlers["discovery.summarize"]!({ campaign_id: campaignId });
		expect((summary.summary as { experiences: number }).experiences).toBe(1);
	});

	it("validates intervention payloads", async () => {
		const handlers = createDiscoveryHostHandlers(engine);
		const created = await handlers["discovery.create"]!({ objective: "find fast code" });
		const campaignId = (created.campaign as { id: string }).id;
		await expect(handlers["discovery.add_candidate"]!({ campaign_id: campaignId, intervention: {} })).rejects.toThrow(
			/command/,
		);
		await expect(
			handlers["discovery.add_candidate"]!({
				campaign_id: campaignId,
				intervention: { command: "true", backend: "aws" },
			}),
		).rejects.toThrow(/backend/);
	});
});
