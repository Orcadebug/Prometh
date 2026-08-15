/**
 * Discovery campaign engine.
 *
 * The host-side authoritative state machine for compute-driven discovery.
 * The engine persists campaigns, records experiences, executes compute
 * interventions through the ComputeRuntime, evaluates scores, maintains
 * archives, replicates results, and produces machine-readable summaries.
 * It never deletes a candidate for scoring poorly.
 */

import { randomUUID } from "node:crypto";
import type { ComputeRuntime } from "../compute/runtime.js";
import type { ComputeMetricValue, ComputeResult } from "../compute/types.js";
import { getDiscoveryStoreDir, listCampaignIds, loadCampaignFile, saveCampaignFile } from "./persistence.js";
import {
	assignArchives,
	compositeScore,
	noveltyScore,
	numericSurprise,
	objectiveScore,
	type ScoringConfig,
} from "./scoring.js";
import type {
	CampaignSummary,
	ComputeExperience,
	DiscoveryArchiveKind,
	DiscoveryBaseline,
	DiscoveryBudgets,
	DiscoveryCampaign,
	DiscoveryRefinementProvenance,
	ExperienceStatus,
} from "./types.js";
import { DEFAULT_DISCOVERY_BUDGETS, normalizeDiscoveryBudgets } from "./types.js";

export interface DiscoveryEngineOptions {
	/** Backing compute runtime. */
	compute: ComputeRuntime;
	/** Session artifact directory for durable campaign persistence. */
	stateDir?: string;
	/** Scoring configuration (objective metric + directions). */
	scoring?: ScoringConfig;
	/** Optional signal for session shutdown. */
	signal?: AbortSignal;
}

export interface CreateCampaignInput {
	objective: string;
	budgets?: DiscoveryBudgets;
	metadata?: Record<string, unknown>;
	/** Optional label for human-readable listings. */
	label?: string;
}

export interface RecordExperienceInput {
	campaignId: string;
	hypothesis?: string;
	rationale?: string;
	intervention: ComputeExperience["intervention"];
	predictedMetrics?: Record<string, ComputeMetricValue>;
	parentExperienceIds?: string[];
	operators?: string[];
	generation?: number;
	reasonSelected?: string;
	metadata?: Record<string, unknown>;
	/** Execute the intervention immediately. Default: true. */
	execute?: boolean;
}

export interface ScoreExperienceInput {
	campaignId: string;
	experienceId: string;
	/** Agent/evaluator-supplied scores, when the model has better context. */
	score?: number;
	noveltyScore?: number;
	surpriseScore?: number;
	validityScore?: number;
	/** Override archive assignment with an explicit list. */
	archives?: DiscoveryArchiveKind[];
	surprise?: {
		expected: Record<string, ComputeMetricValue>;
		observed: Record<string, ComputeMetricValue>;
		reason_surprising?: string;
		surprise_score?: number;
	};
}

export interface ReplicateInput {
	campaignId: string;
	experienceId: string;
	seeds: Array<number | string>;
	/** Optional per-seed command template; `{seed}` is substituted. */
	commandTemplate?: string;
	timeoutMs?: number;
}

export interface RefinementRecommendationInput {
	campaignId: string;
	/** Human/machine-readable lesson to persist through /refine. */
	recommendation: string;
	experienceIds: string[];
	validation?: "passed" | "pending" | "failed";
}

interface CampaignRuntime {
	campaign: DiscoveryCampaign;
	experiences: Map<string, ComputeExperience>;
}

export class DiscoveryEngine {
	private readonly campaigns = new Map<string, CampaignRuntime>();
	private readonly storeDir: string | undefined;
	private readonly scoring: ScoringConfig;

	constructor(private readonly options: DiscoveryEngineOptions) {
		this.storeDir = options.stateDir ? getDiscoveryStoreDir(options.stateDir) : undefined;
		this.scoring = options.scoring ?? {};
		this._restore();
	}

	get activeCampaigns(): DiscoveryCampaign[] {
		return [...this.campaigns.values()]
			.map((runtime) => runtime.campaign)
			.filter((campaign) => campaign.status === "active");
	}

	/** Campaigns whose budget state or pending work warrants another turn. */
	get activeOrPendingCampaigns(): DiscoveryCampaign[] {
		return [...this.campaigns.values()]
			.map((runtime) => runtime.campaign)
			.filter(
				(campaign) =>
					campaign.status === "active" ||
					[...this.campaigns.get(campaign.id)!.experiences.values()].some(
						(experience) => experience.status === "pending" || experience.status === "running",
					),
			);
	}

	/** Signal for autonomous-mode continuation: work remains within budget. */
	hasContinuableWork(): boolean {
		for (const runtime of this.campaigns.values()) {
			if (runtime.campaign.status !== "active") {
				continue;
			}
			const budgetHit = this.checkBudgets(runtime.campaign.id);
			if (budgetHit) {
				continue;
			}
			// An active campaign with budget remaining warrants another turn.
			return true;
		}
		return false;
	}

	async createCampaign(input: CreateCampaignInput): Promise<DiscoveryCampaign> {
		this._assertNotShuttingDown();
		const objective = input.objective.trim();
		if (!objective) {
			throw new Error("discovery.create objective must not be empty");
		}
		if (objective.length > 4000) {
			throw new Error("discovery.create objective is too long");
		}
		const now = new Date().toISOString();
		const campaign: DiscoveryCampaign = {
			id: `dc_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
			objective,
			status: "active",
			createdAt: now,
			updatedAt: now,
			budgets: normalizeDiscoveryBudgets(input.budgets),
			experiences: [],
			elites: [],
			noveltyArchive: [],
			surpriseArchive: [],
			failureArchive: [],
			usage: { jobsSubmitted: 0, jobsCompleted: 0, jobsFailed: 0, tokensClaimed: 0, estimatedGpuHours: 0 },
			metadata: { ...input.metadata, ...(input.label ? { label: input.label } : {}) },
		};
		this.campaigns.set(campaign.id, { campaign, experiences: new Map() });
		this._persist(campaign);
		return campaign;
	}

	async getCampaign(campaignId: string): Promise<DiscoveryCampaign> {
		return this._requireCampaign(campaignId).campaign;
	}

	async listCampaigns(): Promise<DiscoveryCampaign[]> {
		return [...this.campaigns.values()].map((runtime) => runtime.campaign);
	}

	async pauseCampaign(campaignId: string): Promise<DiscoveryCampaign> {
		const runtime = this._requireCampaign(campaignId);
		if (runtime.campaign.status === "active") {
			runtime.campaign.status = "paused";
			this._touch(runtime.campaign);
		}
		return runtime.campaign;
	}

	async resumeCampaign(campaignId: string): Promise<DiscoveryCampaign> {
		const runtime = this._requireCampaign(campaignId);
		if (runtime.campaign.status === "paused") {
			runtime.campaign.status = "active";
			this._touch(runtime.campaign);
		}
		return runtime.campaign;
	}

	/** Record a candidate experience and optionally execute its intervention. */
	async recordExperience(input: RecordExperienceInput): Promise<ComputeExperience> {
		const runtime = this._requireCampaign(input.campaignId);
		this._assertCampaignActive(runtime.campaign);
		const maxExperiences = runtime.campaign.budgets.maxExperiences ?? DEFAULT_DISCOVERY_BUDGETS.maxExperiences;
		if (runtime.experiences.size >= maxExperiences) {
			throw new Error(`discovery campaign ${runtime.campaign.id} experience budget exhausted`);
		}
		const now = new Date().toISOString();
		const experience: ComputeExperience = {
			id: `exp_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
			campaignId: runtime.campaign.id,
			hypothesis: input.hypothesis,
			rationale: input.rationale,
			intervention: { ...input.intervention },
			predictedMetrics: input.predictedMetrics ? { ...input.predictedMetrics } : undefined,
			parentExperienceIds: input.parentExperienceIds ? [...input.parentExperienceIds] : undefined,
			operators: input.operators ? [...input.operators] : undefined,
			generation: input.generation,
			reasonSelected: input.reasonSelected,
			startedAt: now,
			metrics: {},
			status: "pending",
			archives: [],
			artifacts: [],
			metadata: { ...input.metadata },
		};
		runtime.experiences.set(experience.id, experience);
		runtime.campaign.experiences.push(experience.id);
		if (input.generation !== undefined) {
			runtime.campaign.generation = Math.max(runtime.campaign.generation ?? 0, input.generation);
		}
		this._touch(runtime.campaign);

		if (input.execute === false) {
			return experience;
		}
		return this.executeExperience(runtime.campaign.id, experience.id);
	}

	/** Execute the intervention of a pending experience through the compute runtime. */
	async executeExperience(campaignId: string, experienceId: string): Promise<ComputeExperience> {
		const runtime = this._requireCampaign(campaignId);
		// The experience budget was enforced at record time; only the active
		// status is re-checked here, and the compute-job budget below.
		if (runtime.campaign.status !== "active") {
			throw new Error(
				`discovery campaign ${runtime.campaign.id} is not active (status: ${runtime.campaign.status})`,
			);
		}
		const experience = this._requireExperience(runtime, experienceId);
		if (experience.status === "completed" || experience.status === "running") {
			throw new Error(`experience ${experienceId} has already been executed`);
		}
		const maxComputeJobs = runtime.campaign.budgets.maxComputeJobs ?? DEFAULT_DISCOVERY_BUDGETS.maxComputeJobs;
		if (runtime.campaign.usage.jobsSubmitted >= maxComputeJobs) {
			runtime.campaign.status = "budget_exhausted";
			runtime.campaign.metadata.budget_exhausted_reason = `maxComputeJobs (${maxComputeJobs})`;
			this._persist(runtime.campaign);
			throw new Error(`discovery campaign ${runtime.campaign.id} compute job budget exhausted`);
		}
		const intervention = experience.intervention;
		const submission = await this.options.compute.submit({
			command: intervention.command,
			backend: intervention.backend,
			isolation: intervention.isolation,
			budgets: intervention.timeoutMs ? { timeoutMs: intervention.timeoutMs } : undefined,
			files: intervention.files,
			resultFile: intervention.resultFile,
			accelerator: intervention.accelerator,
			estimatedDurationMs: intervention.estimatedDurationMs,
			metadata: { ...experience.metadata, campaignId, experienceId },
		});
		experience.jobId = submission.jobId;
		experience.backend = submission.backend;
		experience.status = "running";
		runtime.campaign.usage.jobsSubmitted++;
		this._touch(runtime.campaign);

		const result = await this.options.compute.result(submission.jobId);
		return this._applyResult(runtime, experience, result);
	}

	/** Attach an externally-obtained compute result to an experience and score it. */
	async attachResult(campaignId: string, experienceId: string, result: ComputeResult): Promise<ComputeExperience> {
		const runtime = this._requireCampaign(campaignId);
		const experience = this._requireExperience(runtime, experienceId);
		return this._applyResult(runtime, experience, result);
	}

	private _applyResult(
		runtime: CampaignRuntime,
		experience: ComputeExperience,
		result: ComputeResult,
	): ComputeExperience {
		experience.result = result;
		experience.metrics = { ...result.metrics };
		experience.completedAt = result.completedAt;
		experience.artifacts = [...result.artifacts];
		experience.status =
			result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed";
		if (experience.status === "completed") {
			runtime.campaign.usage.jobsCompleted++;
		} else {
			runtime.campaign.usage.jobsFailed++;
		}
		if (experience.status === "completed" || experience.status === "failed") {
			this._scoreExperience(runtime, experience, {});
		}
		this._touch(runtime.campaign);
		return experience;
	}

	/** Score (or re-score) an experience, optionally with agent-supplied values. */
	async scoreExperience(input: ScoreExperienceInput): Promise<ComputeExperience> {
		const runtime = this._requireCampaign(input.campaignId);
		const experience = this._requireExperience(runtime, input.experienceId);
		if (input.surprise) {
			experience.surprise = {
				expected: { ...input.surprise.expected },
				observed: { ...input.surprise.observed },
				reason_surprising: input.surprise.reason_surprising,
				surprise_score: clamp01(input.surprise.surprise_score ?? 0.5),
			};
		}
		this._scoreExperience(runtime, experience, {
			score: input.score,
			noveltyScore: input.noveltyScore,
			surpriseScore: input.surpriseScore,
			validityScore: input.validityScore,
			archives: input.archives,
		});
		this._touch(runtime.campaign);
		return experience;
	}

	private _scoreExperience(
		runtime: CampaignRuntime,
		experience: ComputeExperience,
		override: {
			score?: number;
			noveltyScore?: number;
			surpriseScore?: number;
			validityScore?: number;
			archives?: DiscoveryArchiveKind[];
		},
	): void {
		const campaign = runtime.campaign;
		const referenceMetrics = campaign.baseline?.metrics ?? {};
		const objective = override.score ?? objectiveScore(experience.metrics, referenceMetrics, this.scoring);

		const knownCandidates = [...runtime.experiences.values()]
			.filter((known) => known.id !== experience.id && known.status === "completed")
			.map((known) => ({ params: known.intervention.params, metrics: known.metrics }));
		const novelty =
			override.noveltyScore ??
			noveltyScore({
				params: experience.intervention.params,
				metrics: experience.metrics,
				known: knownCandidates,
				operators: experience.operators,
			});

		const surprise =
			override.surpriseScore ??
			(experience.surprise
				? numericSurprise({
						predicted: experience.surprise.expected,
						observed: experience.surprise.observed,
						reasonSurprising: experience.surprise.reason_surprising,
						declaredScore: experience.surprise.surprise_score,
					})
				: numericSurprise({
						predicted: experience.predictedMetrics,
						observed: experience.metrics,
						// A candidate declared invalid (or that failed) is
						// behaviorally surprising: something expected to work
						// did not. Without numeric predictions this still
						// deserves a nonzero surprise signal.
						declaredScore:
							experience.result?.structuredResult?.valid === false || experience.status === "failed"
								? 0.5
								: undefined,
					}));

		const validity =
			override.validityScore ??
			(experience.status === "completed" && experience.result?.structuredResult?.valid !== false ? 1 : 0);

		experience.score = clamp01(objective ?? 0.5);
		experience.noveltyScore = clamp01(novelty);
		experience.surpriseScore = clamp01(surprise);
		experience.validityScore = clamp01(validity);
		experience.compositeScore = compositeScore(objective, novelty, surprise, this.scoring);

		// Determine archive membership against the rest of the campaign.
		const bestSoFar = objective !== undefined && objective > this._bestObjective(runtime, experience.id);
		const novelestSoFar = novelty > this._bestNovelty(runtime, experience.id);
		const mostSurprisingSoFar = surprise > this._bestSurprise(runtime, experience.id);
		const informativeFailure =
			experience.status === "failed" &&
			Boolean(experience.result?.error || experience.result?.stderr.trim() || experience.hypothesis);

		const archives =
			override.archives ??
			assignArchives({
				objective,
				novelty,
				surprise,
				valid: validity >= 0.5,
				bestSoFar,
				novelestSoFar,
				mostSurprisingSoFar,
				informativeFailure,
			});
		experience.archives = [...new Set(archives)];
		campaign.elites = campaign.elites.filter((id) => id !== experience.id);
		campaign.noveltyArchive = campaign.noveltyArchive.filter((id) => id !== experience.id);
		campaign.surpriseArchive = campaign.surpriseArchive.filter((id) => id !== experience.id);
		campaign.failureArchive = campaign.failureArchive.filter((id) => id !== experience.id);
		if (experience.archives.includes("elite")) {
			campaign.elites.push(experience.id);
		}
		if (experience.archives.includes("novelty")) {
			campaign.noveltyArchive.push(experience.id);
		}
		if (experience.archives.includes("surprise")) {
			campaign.surpriseArchive.push(experience.id);
		}
		if (experience.archives.includes("failure")) {
			campaign.failureArchive.push(experience.id);
		}
	}

	private _bestObjective(runtime: CampaignRuntime, excludeId: string): number {
		let best = -Infinity;
		for (const experience of runtime.experiences.values()) {
			if (experience.id === excludeId || experience.score === undefined) {
				continue;
			}
			best = Math.max(best, experience.score);
		}
		return best;
	}

	private _bestNovelty(runtime: CampaignRuntime, excludeId: string): number {
		let best = -Infinity;
		for (const experience of runtime.experiences.values()) {
			if (experience.id === excludeId || experience.noveltyScore === undefined) {
				continue;
			}
			best = Math.max(best, experience.noveltyScore);
		}
		return best;
	}

	private _bestSurprise(runtime: CampaignRuntime, excludeId: string): number {
		let best = -Infinity;
		for (const experience of runtime.experiences.values()) {
			if (experience.id === excludeId || experience.surpriseScore === undefined) {
				continue;
			}
			best = Math.max(best, experience.surpriseScore);
		}
		return best;
	}

	async setBaseline(
		campaignId: string,
		metrics: Record<string, ComputeMetricValue>,
		notes?: string,
	): Promise<DiscoveryCampaign> {
		const runtime = this._requireCampaign(campaignId);
		const baseline: DiscoveryBaseline = {
			metrics: { ...metrics },
			notes,
			createdAt: new Date().toISOString(),
		};
		runtime.campaign.baseline = baseline;
		this._touch(runtime.campaign);
		return runtime.campaign;
	}

	async getBaseline(campaignId: string): Promise<DiscoveryBaseline | undefined> {
		return this._requireCampaign(campaignId).campaign.baseline;
	}

	/** Replicate a completed experience across seeds and record aggregates. */
	async replicate(input: ReplicateInput): Promise<ComputeExperience> {
		const runtime = this._requireCampaign(input.campaignId);
		this._assertCampaignActive(runtime.campaign);
		const experience = this._requireExperience(runtime, input.experienceId);
		if (experience.status !== "completed") {
			throw new Error(`experience ${input.experienceId} must be completed before replication`);
		}
		if (input.seeds.length === 0 || input.seeds.length > 20) {
			throw new Error("discovery.replicate seeds must contain between 1 and 20 entries");
		}
		const maxComputeJobs = runtime.campaign.budgets.maxComputeJobs ?? DEFAULT_DISCOVERY_BUDGETS.maxComputeJobs;
		if (runtime.campaign.usage.jobsSubmitted + input.seeds.length > maxComputeJobs) {
			throw new Error(`discovery campaign ${runtime.campaign.id} compute job budget exhausted by replication`);
		}
		const runs: Array<{
			seed: number | string;
			metrics: Record<string, ComputeMetricValue>;
			status: ExperienceStatus;
		}> = [];
		for (const seed of input.seeds) {
			const command = input.commandTemplate
				? input.commandTemplate.replaceAll("{seed}", String(seed))
				: `${experience.intervention.command} --seed ${String(seed)}`;
			const submission = await this.options.compute.submit({
				command,
				backend: experience.intervention.backend,
				isolation: experience.intervention.isolation,
				budgets:
					(input.timeoutMs ?? experience.intervention.timeoutMs)
						? { timeoutMs: input.timeoutMs ?? experience.intervention.timeoutMs }
						: undefined,
				// Replications re-run the same experiment, so they carry the
				// original intervention's files (scripts, fixtures).
				files: experience.intervention.files,
				metadata: { campaignId: input.campaignId, experienceId: input.experienceId, replicationSeed: String(seed) },
			});
			runtime.campaign.usage.jobsSubmitted++;
			const result = await this.options.compute.result(submission.jobId);
			const status: ExperienceStatus = result.status === "completed" ? "completed" : "failed";
			runs.push({ seed, metrics: { ...result.metrics }, status });
			if (status === "completed") {
				runtime.campaign.usage.jobsCompleted++;
			} else {
				runtime.campaign.usage.jobsFailed++;
			}
		}
		experience.replications = {
			seeds: [...input.seeds],
			runs,
			aggregate: aggregateNumericMetrics(runs.filter((run) => run.status === "completed").map((run) => run.metrics)),
			successfulRuns: runs.filter((run) => run.status === "completed").length,
			failedRuns: runs.filter((run) => run.status === "failed").length,
		};
		this._touch(runtime.campaign);
		return experience;
	}

	/** Produce a machine/human-readable campaign summary. */
	async summarize(campaignId: string): Promise<CampaignSummary> {
		const runtime = this._requireCampaign(campaignId);
		const campaign = runtime.campaign;
		const summary: CampaignSummary = {
			campaignId: campaign.id,
			objective: campaign.objective,
			status: campaign.status,
			baseline: campaign.baseline
				? { metrics: { ...campaign.baseline.metrics }, notes: campaign.baseline.notes }
				: undefined,
			experiences: campaign.experiences.length,
			jobs: { completed: campaign.usage.jobsCompleted, failed: campaign.usage.jobsFailed },
			archives: {
				elite: campaign.elites.length,
				novelty: campaign.noveltyArchive.length,
				surprise: campaign.surpriseArchive.length,
				failure: campaign.failureArchive.length,
			},
			artifacts: [...runtime.experiences.values()].flatMap((experience) =>
				experience.artifacts.map((artifact) => artifact.path),
			),
		};

		const completed = [...runtime.experiences.values()].filter(
			(experience) => experience.status === "completed" && experience.score !== undefined,
		);
		if (completed.length > 0) {
			const best = completed.reduce((a, b) => (b.score! > a.score! ? b : a));
			summary.best = {
				experienceId: best.id,
				metrics: { ...best.metrics },
				change: relativeChange(best.metrics, campaign.baseline?.metrics ?? {}),
				replications: best.replications
					? { successful: best.replications.successfulRuns, failed: best.replications.failedRuns }
					: undefined,
			};
		}

		let mostSurprising: ComputeExperience | undefined;
		for (const experience of runtime.experiences.values()) {
			if (experience.surpriseScore === undefined) {
				continue;
			}
			if (!mostSurprising || experience.surpriseScore > (mostSurprising.surpriseScore ?? 0)) {
				mostSurprising = experience;
			}
		}
		if (mostSurprising) {
			summary.mostSurprising = {
				experienceId: mostSurprising.id,
				reason: mostSurprising.surprise?.reason_surprising ?? mostSurprising.hypothesis,
				surpriseScore: mostSurprising.surpriseScore,
			};
		}

		const usefulFailure = [...runtime.experiences.values()].find(
			(experience) => experience.status === "failed" && experience.archives.includes("failure"),
		);
		if (usefulFailure) {
			summary.usefulFailure = {
				experienceId: usefulFailure.id,
				notes: usefulFailure.result?.stderr.trim() || usefulFailure.result?.error || usefulFailure.hypothesis,
			};
		}

		campaign.summary = summary;
		this._touch(campaign);
		return summary;
	}

	/** Complete a campaign after validation; produces the summary. */
	async complete(campaignId: string): Promise<CampaignSummary> {
		const runtime = this._requireCampaign(campaignId);
		const summary = await this.summarize(campaignId);
		runtime.campaign.status = "completed";
		this._touch(runtime.campaign);
		return summary;
	}

	/** Mark a campaign budget-exhausted when a bound has been reached. */
	async markBudgetExhausted(campaignId: string, reason?: string): Promise<DiscoveryCampaign> {
		const runtime = this._requireCampaign(campaignId);
		runtime.campaign.status = "budget_exhausted";
		if (reason) {
			runtime.campaign.metadata.budget_exhausted_reason = reason;
		}
		this._touch(runtime.campaign);
		return runtime.campaign;
	}

	/**
	 * Whether a campaign has hit any of its budgets. Returns the first
	 * exhausted bound, or undefined when the campaign may continue.
	 */
	checkBudgets(campaignId: string, now = Date.now()): string | undefined {
		const campaign = this._requireCampaign(campaignId).campaign;
		const budgets = { ...DEFAULT_DISCOVERY_BUDGETS, ...campaign.budgets };
		if (campaign.experiences.length >= budgets.maxExperiences) {
			return `maxExperiences (${budgets.maxExperiences})`;
		}
		if (campaign.usage.jobsSubmitted >= budgets.maxComputeJobs) {
			return `maxComputeJobs (${budgets.maxComputeJobs})`;
		}
		if (now - Date.parse(campaign.createdAt) >= budgets.maxWallTimeMs) {
			return `maxWallTime (${budgets.maxWallTimeMs}ms)`;
		}
		if (campaign.usage.tokensClaimed >= budgets.maxTokens) {
			return `maxTokens (${budgets.maxTokens})`;
		}
		return undefined;
	}

	async getExperience(campaignId: string, experienceId: string): Promise<ComputeExperience> {
		return this._requireExperience(this._requireCampaign(campaignId), experienceId);
	}

	async listExperiences(campaignId: string): Promise<ComputeExperience[]> {
		return [...this._requireCampaign(campaignId).experiences.values()];
	}

	async archives(campaignId: string): Promise<Record<DiscoveryArchiveKind, string[]>> {
		const campaign = this._requireCampaign(campaignId).campaign;
		return {
			elite: [...campaign.elites],
			novelty: [...campaign.noveltyArchive],
			surprise: [...campaign.surpriseArchive],
			failure: [...campaign.failureArchive],
		};
	}

	/** Build refinement provenance for a validated discovery. */
	buildRefinementProvenance(input: RefinementRecommendationInput): DiscoveryRefinementProvenance {
		const runtime = this._requireCampaign(input.campaignId);
		const validatedIds = input.experienceIds.filter((id) => runtime.experiences.has(id));
		const replications = Math.max(
			0,
			...validatedIds.map((id) => runtime.experiences.get(id)?.replications?.successfulRuns ?? 0),
		);
		return {
			source: "discovery",
			campaign_id: input.campaignId,
			experience_ids: validatedIds,
			replications,
			validation: input.validation ?? "pending",
			generated_at: new Date().toISOString(),
		};
	}

	/** Format a human-readable campaign summary for the user/model. */
	formatCampaignSummary(campaign: DiscoveryCampaign): string {
		const lines: string[] = [
			`Discovery Campaign: ${campaign.id}`,
			`Objective: ${campaign.objective}`,
			`Status: ${campaign.status}`,
			`Experiences: ${campaign.experiences.length}`,
			`Jobs: ${campaign.usage.jobsCompleted} completed, ${campaign.usage.jobsFailed} failed`,
			`Archives: ${campaign.elites.length} elite, ${campaign.noveltyArchive.length} novelty, ${campaign.surpriseArchive.length} surprise, ${campaign.failureArchive.length} failure`,
		];
		if (campaign.baseline) {
			lines.push(`Baseline: ${JSON.stringify(campaign.baseline.metrics)}`);
		}
		if (campaign.summary?.best) {
			lines.push(`Best validated result: ${JSON.stringify(campaign.summary.best.metrics)}`);
		}
		return lines.join("\n");
	}

	private _requireCampaign(campaignId: string): CampaignRuntime {
		const runtime = this.campaigns.get(campaignId);
		if (!runtime) {
			throw new Error(`unknown discovery campaign "${campaignId}"`);
		}
		return runtime;
	}

	private _requireExperience(runtime: CampaignRuntime, experienceId: string): ComputeExperience {
		const experience = runtime.experiences.get(experienceId);
		if (!experience) {
			throw new Error(`unknown discovery experience "${experienceId}"`);
		}
		return experience;
	}

	private _assertCampaignActive(campaign: DiscoveryCampaign): void {
		if (campaign.status !== "active") {
			throw new Error(`discovery campaign ${campaign.id} is not active (status: ${campaign.status})`);
		}
		const budgetHit = this.checkBudgets(campaign.id);
		if (budgetHit) {
			campaign.status = "budget_exhausted";
			campaign.metadata.budget_exhausted_reason = budgetHit;
			this._persist(campaign);
			throw new Error(`discovery campaign ${campaign.id} budget exhausted: ${budgetHit}`);
		}
	}

	private _assertNotShuttingDown(): void {
		if (this.options.signal?.aborted) {
			throw new Error("discovery engine is shutting down");
		}
	}

	private _touch(campaign: DiscoveryCampaign): void {
		campaign.updatedAt = new Date().toISOString();
		this._persist(campaign);
	}

	private _persist(campaign: DiscoveryCampaign): void {
		if (!this.storeDir) {
			return;
		}
		const runtime = this.campaigns.get(campaign.id);
		const experiences = runtime ? [...runtime.experiences.values()] : [];
		saveCampaignFile(this.storeDir, campaign, experiences);
	}

	private _restore(): void {
		if (!this.storeDir) {
			return;
		}
		for (const campaignId of listCampaignIds(this.storeDir)) {
			const loaded = loadCampaignFile(this.storeDir, campaignId);
			if (!loaded) {
				continue;
			}
			this.campaigns.set(loaded.campaign.id, {
				campaign: loaded.campaign,
				experiences: new Map(loaded.experiences.map((experience) => [experience.id, experience])),
			});
		}
	}
}

function aggregateNumericMetrics(
	metricsList: Array<Record<string, ComputeMetricValue>>,
): Record<string, ComputeMetricValue> {
	if (metricsList.length === 0) {
		return {};
	}
	const keys = new Set(metricsList.flatMap((metrics) => Object.keys(metrics)));
	const result: Record<string, ComputeMetricValue> = {};
	for (const key of keys) {
		const values = metricsList
			.map((metrics) => metrics[key])
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		if (values.length === 0) {
			continue;
		}
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		result[`${key}_mean`] = round(mean);
		if (values.length > 1) {
			const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
			result[`${key}_stddev`] = round(Math.sqrt(variance));
		}
		result[`${key}_min`] = round(Math.min(...values));
		result[`${key}_max`] = round(Math.max(...values));
	}
	result.successful_runs = metricsList.length;
	return result;
}

function relativeChange(
	metrics: Record<string, ComputeMetricValue>,
	baseline: Record<string, ComputeMetricValue>,
): Record<string, number | null> {
	const result: Record<string, number | null> = {};
	for (const [key, value] of Object.entries(metrics)) {
		if (typeof value !== "number" || typeof baseline[key] !== "number" || baseline[key] === 0) {
			result[key] = null;
			continue;
		}
		result[key] = round(((value - baseline[key]) / Math.abs(baseline[key])) * 100);
	}
	return result;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export { getCampaignFilePath, getDiscoveryStoreDir } from "./persistence.js";
