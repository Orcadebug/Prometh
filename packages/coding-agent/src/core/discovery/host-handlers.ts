/**
 * Host-request bridge for the discovery subsystem.
 *
 * Exposes the DiscoveryEngine to the IPython kernel through the typed
 * host-request pattern. All validation happens host-side; payload keys are
 * snake_case on the wire.
 */

import type { HostRequestHandler } from "../kernel/index.js";
import type { DiscoveryEngine } from "./engine.js";
import type { ComputeMetricValue, DiscoveryArchiveKind, DiscoveryCampaign } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCampaignId(payload: Record<string, unknown>, requestType: string): string {
	if (typeof payload.campaign_id !== "string" || payload.campaign_id.trim().length === 0) {
		throw new Error(`${requestType} campaign_id must be a non-empty string`);
	}
	return payload.campaign_id;
}

function readExperienceId(payload: Record<string, unknown>, requestType: string): string {
	if (typeof payload.experience_id !== "string" || payload.experience_id.trim().length === 0) {
		throw new Error(`${requestType} experience_id must be a non-empty string`);
	}
	return payload.experience_id;
}

function readMetrics(value: unknown, field: string): Record<string, ComputeMetricValue> {
	if (!isRecord(value)) {
		throw new Error(`${field} must be an object of metric values`);
	}
	const metrics: Record<string, ComputeMetricValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "number" || typeof entry === "string" || typeof entry === "boolean") {
			metrics[key] = entry;
		}
	}
	return metrics;
}

function readBudgets(value: unknown): {
	maxExperiences?: number;
	maxTokens?: number;
	maxWallTimeMs?: number;
	maxComputeJobs?: number;
} {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw new Error("discovery.create budgets must be an object");
	}
	const budgets: ReturnType<typeof readBudgets> = {};
	if (value.max_experiences !== undefined) {
		if (!Number.isInteger(value.max_experiences) || (value.max_experiences as number) <= 0) {
			throw new Error("budgets.max_experiences must be a positive integer");
		}
		budgets.maxExperiences = value.max_experiences as number;
	}
	if (value.max_tokens !== undefined) {
		if (!Number.isInteger(value.max_tokens) || (value.max_tokens as number) <= 0) {
			throw new Error("budgets.max_tokens must be a positive integer");
		}
		budgets.maxTokens = value.max_tokens as number;
	}
	if (value.max_wall_time_ms !== undefined) {
		if (!Number.isFinite(value.max_wall_time_ms) || (value.max_wall_time_ms as number) <= 0) {
			throw new Error("budgets.max_wall_time_ms must be a positive number");
		}
		budgets.maxWallTimeMs = value.max_wall_time_ms as number;
	}
	if (value.max_compute_jobs !== undefined) {
		if (!Number.isInteger(value.max_compute_jobs) || (value.max_compute_jobs as number) <= 0) {
			throw new Error("budgets.max_compute_jobs must be a positive integer");
		}
		budgets.maxComputeJobs = value.max_compute_jobs as number;
	}
	return budgets;
}

function readIntervention(value: unknown): {
	command: string;
	backend?: "local" | "kaggle";
	isolation?: "local" | "worktree";
	timeoutMs?: number;
	files?: Array<{ path: string; content: string }>;
	resultFile?: string;
	accelerator?: string;
	estimatedDurationMs?: number;
	params?: Record<string, ComputeMetricValue>;
} {
	if (!isRecord(value)) {
		throw new Error("discovery.add_candidate intervention must be an object");
	}
	if (typeof value.command !== "string" || value.command.trim().length === 0) {
		throw new Error("intervention.command must be a non-empty string");
	}
	const intervention: ReturnType<typeof readIntervention> = { command: value.command };
	if (value.backend !== undefined) {
		if (value.backend !== "local" && value.backend !== "kaggle") {
			throw new Error('intervention.backend must be "local" or "kaggle"');
		}
		intervention.backend = value.backend;
	}
	if (value.isolation !== undefined) {
		if (value.isolation !== "local" && value.isolation !== "worktree") {
			throw new Error('intervention.isolation must be "local" or "worktree"');
		}
		intervention.isolation = value.isolation;
	}
	if (value.timeout_ms !== undefined) {
		if (typeof value.timeout_ms !== "number" || !Number.isFinite(value.timeout_ms) || value.timeout_ms <= 0) {
			throw new Error("intervention.timeout_ms must be a positive number");
		}
		intervention.timeoutMs = value.timeout_ms;
	}
	if (value.files !== undefined) {
		if (!Array.isArray(value.files) || value.files.length > 200) {
			throw new Error("intervention.files must be an array of at most 200 entries");
		}
		intervention.files = value.files.map((entry, index) => {
			if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.content !== "string") {
				throw new Error(`intervention.files[${index}] must have string path and content`);
			}
			return { path: entry.path, content: entry.content };
		});
	}
	if (value.result_file !== undefined) {
		if (typeof value.result_file !== "string") {
			throw new Error("intervention.result_file must be a string");
		}
		intervention.resultFile = value.result_file;
	}
	if (value.accelerator !== undefined) {
		if (typeof value.accelerator !== "string") {
			throw new Error("intervention.accelerator must be a string");
		}
		intervention.accelerator = value.accelerator;
	}
	if (value.estimated_duration_ms !== undefined) {
		if (typeof value.estimated_duration_ms !== "number" || value.estimated_duration_ms <= 0) {
			throw new Error("intervention.estimated_duration_ms must be a positive number");
		}
		intervention.estimatedDurationMs = value.estimated_duration_ms;
	}
	if (value.params !== undefined) {
		intervention.params = readMetrics(value.params, "intervention.params");
	}
	return intervention;
}

function readArchives(value: unknown): DiscoveryArchiveKind[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error("archives must be an array");
	}
	const valid: DiscoveryArchiveKind[] = ["elite", "novelty", "surprise", "failure"];
	const archives: DiscoveryArchiveKind[] = [];
	for (const entry of value) {
		if (!valid.includes(entry as DiscoveryArchiveKind)) {
			throw new Error(`unknown archive kind "${String(entry)}"`);
		}
		archives.push(entry as DiscoveryArchiveKind);
	}
	return archives;
}

/** Compact serialization of a campaign for kernel replies. */
function serializeCampaign(campaign: DiscoveryCampaign): Record<string, unknown> {
	return {
		id: campaign.id,
		objective: campaign.objective,
		status: campaign.status,
		created_at: campaign.createdAt,
		updated_at: campaign.updatedAt,
		budgets: campaign.budgets,
		experiences: campaign.experiences,
		elites: campaign.elites,
		novelty_archive: campaign.noveltyArchive,
		surprise_archive: campaign.surpriseArchive,
		failure_archive: campaign.failureArchive,
		generation: campaign.generation,
		baseline: campaign.baseline,
		usage: campaign.usage,
		summary: campaign.summary,
		metadata: campaign.metadata,
	};
}

function serializeExperience(experience: import("./types.js").ComputeExperience): Record<string, unknown> {
	return {
		id: experience.id,
		campaign_id: experience.campaignId,
		parent_experience_ids: experience.parentExperienceIds,
		operators: experience.operators,
		generation: experience.generation,
		reason_selected: experience.reasonSelected,
		hypothesis: experience.hypothesis,
		rationale: experience.rationale,
		intervention: experience.intervention,
		predicted_metrics: experience.predictedMetrics,
		started_at: experience.startedAt,
		completed_at: experience.completedAt,
		backend: experience.backend,
		job_id: experience.jobId,
		metrics: experience.metrics,
		score: experience.score,
		novelty_score: experience.noveltyScore,
		surprise_score: experience.surpriseScore,
		validity_score: experience.validityScore,
		composite_score: experience.compositeScore,
		surprise: experience.surprise,
		status: experience.status,
		archives: experience.archives,
		artifacts: experience.artifacts,
		replications: experience.replications,
		metadata: experience.metadata,
	};
}

export function createDiscoveryHostHandlers(engine: DiscoveryEngine): Record<string, HostRequestHandler> {
	const handlers: Record<string, HostRequestHandler> = {
		"discovery.create": async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
			if (typeof payload.objective !== "string") {
				throw new Error("discovery.create objective must be a string");
			}
			const campaign = await engine.createCampaign({
				objective: payload.objective,
				budgets: readBudgets(payload.budgets),
				label: typeof payload.label === "string" ? payload.label : undefined,
				metadata: isRecord(payload.metadata) ? payload.metadata : undefined,
			});
			return { campaign: serializeCampaign(campaign) };
		},
		"discovery.status": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.status");
			const campaign = await engine.getCampaign(campaignId);
			return { campaign: serializeCampaign(campaign) };
		},
		"discovery.list": async (): Promise<Record<string, unknown>> => {
			const campaigns = await engine.listCampaigns();
			return { campaigns: campaigns.map((campaign) => serializeCampaign(campaign)) };
		},
		"discovery.add_candidate": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.add_candidate");
			const intervention = readIntervention(payload.intervention);
			const experience = await engine.recordExperience({
				campaignId,
				intervention,
				hypothesis: typeof payload.hypothesis === "string" ? payload.hypothesis : undefined,
				rationale: typeof payload.rationale === "string" ? payload.rationale : undefined,
				predictedMetrics:
					payload.predicted_metrics !== undefined
						? readMetrics(payload.predicted_metrics, "predicted_metrics")
						: undefined,
				parentExperienceIds: Array.isArray(payload.parent_experience_ids)
					? payload.parent_experience_ids.filter((id): id is string => typeof id === "string")
					: undefined,
				operators: Array.isArray(payload.operators)
					? payload.operators.filter((operator): operator is string => typeof operator === "string")
					: undefined,
				generation: typeof payload.generation === "number" ? payload.generation : undefined,
				reasonSelected: typeof payload.reason_selected === "string" ? payload.reason_selected : undefined,
				metadata: isRecord(payload.metadata) ? payload.metadata : undefined,
				execute: payload.execute !== false,
			});
			return { experience: serializeExperience(experience) };
		},
		"discovery.score": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.score");
			const experienceId = readExperienceId(payload, "discovery.score");
			const surpriseValue = payload.surprise;
			const experience = await engine.scoreExperience({
				campaignId,
				experienceId,
				score: typeof payload.score === "number" ? payload.score : undefined,
				noveltyScore: typeof payload.novelty_score === "number" ? payload.novelty_score : undefined,
				surpriseScore: typeof payload.surprise_score === "number" ? payload.surprise_score : undefined,
				validityScore: typeof payload.validity_score === "number" ? payload.validity_score : undefined,
				archives: readArchives(payload.archives),
				surprise: isRecord(surpriseValue)
					? {
							expected: readMetrics(surpriseValue.expected, "surprise.expected"),
							observed: readMetrics(surpriseValue.observed, "surprise.observed"),
							reason_surprising:
								typeof surpriseValue.reason_surprising === "string"
									? surpriseValue.reason_surprising
									: undefined,
							surprise_score:
								typeof surpriseValue.surprise_score === "number" ? surpriseValue.surprise_score : undefined,
						}
					: undefined,
			});
			return { experience: serializeExperience(experience) };
		},
		"discovery.experiences": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.experiences");
			const experiences = await engine.listExperiences(campaignId);
			return { experiences: experiences.map((experience) => serializeExperience(experience)) };
		},
		"discovery.archives": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.archives");
			const archives = await engine.archives(campaignId);
			return {
				elite: archives.elite,
				novelty: archives.novelty,
				surprise: archives.surprise,
				failure: archives.failure,
			};
		},
		"discovery.set_baseline": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.set_baseline");
			const metrics = readMetrics(payload.metrics, "discovery.set_baseline metrics");
			if (Object.keys(metrics).length === 0) {
				throw new Error("discovery.set_baseline metrics must not be empty");
			}
			const campaign = await engine.setBaseline(
				campaignId,
				metrics,
				typeof payload.notes === "string" ? payload.notes : undefined,
			);
			return { campaign: serializeCampaign(campaign) };
		},
		"discovery.replicate": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.replicate");
			const experienceId = readExperienceId(payload, "discovery.replicate");
			if (!Array.isArray(payload.seeds) || payload.seeds.length === 0) {
				throw new Error("discovery.replicate seeds must be a non-empty array");
			}
			const seeds = payload.seeds.filter(
				(seed): seed is number | string => typeof seed === "number" || typeof seed === "string",
			);
			if (seeds.length !== payload.seeds.length) {
				throw new Error("discovery.replicate seeds must be numbers or strings");
			}
			const experience = await engine.replicate({
				campaignId,
				experienceId,
				seeds,
				commandTemplate: typeof payload.command_template === "string" ? payload.command_template : undefined,
				timeoutMs: typeof payload.timeout_ms === "number" ? payload.timeout_ms : undefined,
			});
			return { experience: serializeExperience(experience) };
		},
		"discovery.summarize": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.summarize");
			const summary = await engine.summarize(campaignId);
			return { summary };
		},
		"discovery.complete": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.complete");
			const summary = await engine.complete(campaignId);
			return { summary };
		},
		"discovery.pause": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.pause");
			const campaign = await engine.pauseCampaign(campaignId);
			return { campaign: serializeCampaign(campaign) };
		},
		"discovery.resume": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.resume");
			const campaign = await engine.resumeCampaign(campaignId);
			return { campaign: serializeCampaign(campaign) };
		},
		"discovery.refinement_provenance": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.refinement_provenance");
			if (!Array.isArray(payload.experience_ids)) {
				throw new Error("discovery.refinement_provenance experience_ids must be an array");
			}
			const provenance = engine.buildRefinementProvenance({
				campaignId,
				recommendation: typeof payload.recommendation === "string" ? payload.recommendation : "",
				experienceIds: payload.experience_ids.filter((id): id is string => typeof id === "string"),
				validation:
					payload.validation === "passed" || payload.validation === "pending" || payload.validation === "failed"
						? payload.validation
						: undefined,
			});
			return { provenance };
		},
		"discovery.budget_status": async (payload): Promise<Record<string, unknown>> => {
			const campaignId = readCampaignId(payload, "discovery.budget_status");
			const budgetHit = engine.checkBudgets(campaignId);
			const campaign = await engine.getCampaign(campaignId);
			return {
				budget_hit: budgetHit ?? null,
				usage: campaign.usage,
				budgets: campaign.budgets,
			};
		},
	};
	return handlers;
}
