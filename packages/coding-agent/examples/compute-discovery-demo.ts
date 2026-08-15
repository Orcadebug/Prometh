/**
 * End-to-end compute-driven discovery demo (local, no GPU, no API keys).
 *
 * Demonstrates the full loop on a deliberately inefficient implementation:
 * baseline -> propose variants -> execute real jobs -> observe -> score ->
 * preserve elites/novelty/surprise/failures -> replicate the winner ->
 * summarize -> validate.
 *
 * Run from the coding-agent package root:
 *   npx tsx examples/compute-discovery-demo.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeRuntime } from "../src/core/compute/runtime.js";
import { DiscoveryEngine } from "../src/core/discovery/engine.js";

function benchCommand(variant: string): string {
	return `python3 bench.py ${variant}`;
}

const BENCH_SCRIPT = [
	"import sys, time, json",
	"def slow_sum(n):",
	"    total = 0",
	"    for i in range(n):",
	"        total += i",
	"    return total",
	"def fast_sum(n):",
	"    return n * (n - 1) // 2",
	"def shift_sum(n):",
	"    return n * n - n >> 1",
	"def off_by_one(n):",
	"    return n * (n - 1) // 2 + 1",
	"impls = {'slow_sum': slow_sum, 'fast_sum': fast_sum, 'shift_sum': shift_sum, 'off_by_one': off_by_one}",
	"impl = impls[sys.argv[1]]",
	"n = 2_000_000",
	"start = time.perf_counter()",
	"value = impl(n)",
	"elapsed_ms = (time.perf_counter() - start) * 1000",
	"print(json.dumps({'prime_discovery_result': {'metrics': {'latency_ms': round(elapsed_ms, 3)}, 'valid': value == 1999999000000}}))",
].join("\n");

async function main(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-discovery-demo-"));
	const compute = new ComputeRuntime({
		defaultCwd: dir,
		stateDir: join(dir, "compute-state"),
		maxConcurrency: 2,
	});
	const engine = new DiscoveryEngine({
		compute,
		stateDir: join(dir, "session-artifacts"),
		scoring: {
			objectiveMetric: "latency_ms",
			directions: { latency_ms: "minimize" },
		},
	});

	console.log("== Compute-Driven Discovery Demo ==\n");

	// 1. Create the campaign and establish the baseline.
	const campaign = await engine.createCampaign({
		objective: "Reduce summation latency while preserving correctness",
		budgets: { maxExperiences: 10, maxComputeJobs: 20 },
	});

	const baselineJob = await compute.submit({
		command: benchCommand("slow_sum"),
		label: "baseline",
		files: [{ path: "bench.py", content: BENCH_SCRIPT }],
	});
	const baselineResult = await compute.result(baselineJob.jobId);
	console.log(`Baseline run: ${JSON.stringify(baselineResult.metrics)}`);
	await engine.setBaseline(campaign.id, baselineResult.metrics, "deliberately slow loop implementation");

	// 2. Propose structurally different candidates.
	const candidates: Array<{
		name: string;
		command: string;
		hypothesis: string;
		operators: string[];
		params: Record<string, string | number>;
	}> = [
		{
			name: "slow again",
			command: benchCommand("slow_sum"),
			hypothesis: "repeat the baseline",
			operators: ["baseline"],
			params: { impl: "slow_sum" },
		},
		{
			name: "closed form",
			command: benchCommand("fast_sum"),
			hypothesis: "closed-form arithmetic removes the loop entirely",
			operators: ["change_representation"],
			params: { impl: "fast_sum" },
		},
		{
			name: "bit-shift division",
			command: benchCommand("shift_sum"),
			hypothesis: "bit-shift division might be faster",
			operators: ["mutate"],
			params: { impl: "shift_sum" },
		},
		{
			name: "off-by-one variant",
			command: benchCommand("off_by_one"),
			hypothesis: "slightly wrong variant; expected to work",
			operators: ["adversarial_variant"],
			params: { impl: "off_by_one" },
		},
	];

	const parentIds: string[] = [];
	for (const candidate of candidates) {
		const experience = await engine.recordExperience({
			campaignId: campaign.id,
			hypothesis: candidate.hypothesis,
			intervention: {
				command: candidate.command,
				params: candidate.params,
				files: [{ path: "bench.py", content: BENCH_SCRIPT }],
			},
			operators: candidate.operators,
			parentExperienceIds: parentIds.length > 0 ? [parentIds[0]] : undefined,
			generation: 0,
			reasonSelected: candidate.name,
		});
		parentIds.push(experience.id);
		console.log(
			`${experience.status === "completed" ? "ok  " : "FAIL"} ${candidate.name}: metrics=${JSON.stringify(experience.metrics)} score=${experience.score?.toFixed(3)} archives=${experience.archives.join(",")}`,
		);
	}

	// 3. Inspect archives — the surprising failure must be preserved.
	const archives = await engine.archives(campaign.id);
	console.log(
		`\nArchives: elite=${archives.elite.length} novelty=${archives.novelty.length} surprise=${archives.surprise.length} failure=${archives.failure.length}`,
	);

	// 4. Replicate the winner across seeds.
	const experiences = await engine.listExperiences(campaign.id);
	const winner = experiences
		.filter((experience) => experience.status === "completed" && experience.score !== undefined)
		.reduce((a, b) => (b.score! > a.score! ? b : a));
	console.log(`\nWinner: ${winner.reasonSelected ?? winner.id} (score ${winner.score?.toFixed(3)})`);
	const replicated = await engine.replicate({
		campaignId: campaign.id,
		experienceId: winner.id,
		seeds: [1, 2, 3],
		commandTemplate: winner.intervention.command,
	});
	console.log(
		`Replications: ${replicated.replications?.successfulRuns}/${replicated.replications?.seeds.length} successful, aggregate=${JSON.stringify(replicated.replications?.aggregate)}`,
	);

	// 5. Summarize and validate.
	const summary = await engine.summarize(campaign.id);
	console.log(`\nBest change vs baseline: ${JSON.stringify(summary.best?.change)}`);
	if (summary.mostSurprising) {
		console.log(`Most surprising: ${summary.mostSurprising.experienceId} (${summary.mostSurprising.surpriseScore})`);
	}
	if (summary.usefulFailure) {
		console.log(`Useful failure preserved: ${summary.usefulFailure.experienceId}`);
	}

	const provenance = engine.buildRefinementProvenance({
		campaignId: campaign.id,
		recommendation: "Prefer closed-form arithmetic over loops in hot numeric paths",
		experienceIds: [winner.id],
		validation: "passed",
	});
	console.log(`\nRefinement provenance: ${JSON.stringify(provenance)}`);

	await engine.complete(campaign.id);
	const final = await engine.getCampaign(campaign.id);
	console.log(`\nCampaign ${final.id} finished with status ${final.status}.`);
	console.log(engine.formatCampaignSummary(final));

	compute.dispose();
	rmSync(dir, { recursive: true, force: true });
	console.log("\nDemo complete.");
}

void main().catch((error) => {
	console.error("Demo failed:", error);
	process.exitCode = 1;
});
