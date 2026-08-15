/**
 * Discovery subsystem types.
 *
 * A DiscoveryCampaign is a durable, bounded search process organized around
 * the loop: propose -> execute real computation -> observe -> record
 * experience -> evaluate -> reinterpret -> propose again. The host persists
 * campaigns, experiences, lineage, archives, baselines, replications, and
 * budget accounting; the model proposes and interprets.
 */

import type {
	ComputeArtifact,
	ComputeBackendId,
	ComputeIsolation,
	ComputeMetricValue,
	ComputeResult,
} from "../compute/types.js";

export type { ComputeMetricValue };

export type DiscoveryCampaignStatus = "active" | "paused" | "completed" | "budget_exhausted" | "failed";
export type ExperienceStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type DiscoveryArchiveKind = "elite" | "novelty" | "surprise" | "failure";

/** Known search/intervention operators. The model may propose additional operator names. */
export const KNOWN_SEARCH_OPERATORS = [
	"mutate",
	"combine",
	"crossover",
	"invert",
	"simplify",
	"generalize",
	"specialize",
	"remove_assumption",
	"change_representation",
	"change_objective",
	"adversarial_variant",
	"extreme_case",
	"random_restart",
	"counterexample_search",
	"baseline",
] as const;

export interface DiscoveryBudgets {
	/** Maximum number of recorded experiences. */
	maxExperiences?: number;
	/** Maximum total tokens of model reasoning the campaign may claim (informational for the host). */
	maxTokens?: number;
	/** Maximum wall-clock time from campaign creation, in milliseconds. */
	maxWallTimeMs?: number;
	/** Maximum number of compute jobs submitted. */
	maxComputeJobs?: number;
	/** Maximum declared/estimated GPU hours. */
	maxEstimatedGpuHours?: number;
	/** Maximum estimated dollar cost (only when a backend can estimate it). */
	maxEstimatedCostUsd?: number;
}

/** A concrete computational intervention proposed for a campaign. */
export interface ComputeIntervention {
	/** Command to execute on the compute backend. */
	command: string;
	/** Target backend; defaults to local. */
	backend?: ComputeBackendId;
	/** Isolation mode; defaults to local. */
	isolation?: ComputeIsolation;
	/** Per-job timeout in milliseconds. */
	timeoutMs?: number;
	/** Files materialized into the job working directory before execution. */
	files?: Array<{ path: string; content: string }>;
	/** Path to a result JSON file the job writes (result protocol). */
	resultFile?: string;
	/** Declared accelerator for accounting. */
	accelerator?: string;
	/** Declared estimate of compute duration in milliseconds. */
	estimatedDurationMs?: number;
	/** Structured parameter set (for novelty distance and lineage). */
	params?: Record<string, ComputeMetricValue>;
}

export interface SurpriseRecord {
	/** Predicted metric values, when the proposer recorded expectations. */
	expected: Record<string, ComputeMetricValue>;
	/** Observed metric values. */
	observed: Record<string, ComputeMetricValue>;
	/** Agent-supplied or evaluator-derived reason this is surprising. */
	reason_surprising?: string;
	/** Surprise score in [0, 1]. */
	surprise_score: number;
}

export interface ComputeExperience {
	id: string;
	campaignId: string;

	/** Parent experience ids for lineage. */
	parentExperienceIds?: string[];
	/** Search operators applied to produce this candidate. */
	operators?: string[];
	/** Generation number within the campaign. */
	generation?: number;
	/** Why this candidate was selected. */
	reasonSelected?: string;

	/** What the candidate is expected to show. */
	hypothesis?: string;
	rationale?: string;

	intervention: ComputeIntervention;

	/** Predicted metrics before execution (for numeric surprise). */
	predictedMetrics?: Record<string, ComputeMetricValue>;

	startedAt: string;
	completedAt?: string;

	/** Backend the job ran on. */
	backend?: ComputeBackendId;
	/** Durable compute job id. */
	jobId?: string;

	result?: ComputeResult;
	metrics: Record<string, ComputeMetricValue>;

	score?: number;
	noveltyScore?: number;
	surpriseScore?: number;
	validityScore?: number;
	compositeScore?: number;

	surprise?: SurpriseRecord;

	status: ExperienceStatus;

	/** Archives this experience currently belongs to. */
	archives: DiscoveryArchiveKind[];

	artifacts: ComputeArtifact[];

	/** Replication evidence attached to this experience. */
	replications?: {
		seeds: Array<number | string>;
		runs: Array<{ seed: number | string; metrics: Record<string, ComputeMetricValue>; status: ExperienceStatus }>;
		aggregate: Record<string, ComputeMetricValue>;
		successfulRuns: number;
		failedRuns: number;
	};

	metadata: Record<string, unknown>;
}

export interface DiscoveryBaseline {
	metrics: Record<string, ComputeMetricValue>;
	notes?: string;
	createdAt: string;
	/** Experience id of the baseline run, when the baseline was computed. */
	sourceExperienceId?: string;
}

export interface DiscoveryCampaign {
	id: string;
	objective: string;
	status: DiscoveryCampaignStatus;
	createdAt: string;
	updatedAt: string;
	budgets: DiscoveryBudgets;
	/** Experience ids in creation order. */
	experiences: string[];
	/** Experience ids in the elite archive. */
	elites: string[];
	/** Experience ids in the novelty archive. */
	noveltyArchive: string[];
	/** Experience ids in the surprise archive. */
	surpriseArchive: string[];
	/** Experience ids in the interesting-failure archive. */
	failureArchive: string[];
	generation?: number;
	baseline?: DiscoveryBaseline;
	/** Usage accounting. */
	usage: {
		jobsSubmitted: number;
		jobsCompleted: number;
		jobsFailed: number;
		tokensClaimed: number;
		estimatedGpuHours: number;
	};
	/** Machine-readable summary produced at completion. */
	summary?: CampaignSummary;
	metadata: Record<string, unknown>;
}

export interface CampaignSummary {
	campaignId: string;
	objective: string;
	status: DiscoveryCampaignStatus;
	baseline?: { metrics: Record<string, ComputeMetricValue>; notes?: string };
	experiences: number;
	jobs: { completed: number; failed: number };
	best?: {
		experienceId: string;
		metrics: Record<string, ComputeMetricValue>;
		change: Record<string, number | null>;
		replications?: { successful: number; failed: number };
	};
	mostSurprising?: { experienceId: string; reason?: string; surpriseScore?: number };
	usefulFailure?: { experienceId: string; notes?: string };
	archives: { elite: number; novelty: number; surprise: number; failure: number };
	recommendedRefinement?: string;
	artifacts: string[];
}

/** Machine-readable validation provenance for /refine integration. */
export interface DiscoveryRefinementProvenance {
	source: "discovery";
	campaign_id: string;
	experience_ids: string[];
	replications: number;
	validation: "passed" | "pending" | "failed";
	generated_at: string;
}

export const DEFAULT_DISCOVERY_BUDGETS: Required<DiscoveryBudgets> = {
	maxExperiences: 100,
	maxTokens: 400_000,
	maxWallTimeMs: 6 * 60 * 60 * 1000,
	maxComputeJobs: 200,
	maxEstimatedGpuHours: 0,
	maxEstimatedCostUsd: 0,
};

export function normalizeDiscoveryBudgets(budgets: DiscoveryBudgets = {}): DiscoveryBudgets {
	const result: DiscoveryBudgets = {};
	if (budgets.maxExperiences !== undefined) {
		if (!Number.isInteger(budgets.maxExperiences) || budgets.maxExperiences <= 0) {
			throw new Error("discovery budgets.max_experiences must be a positive integer");
		}
		result.maxExperiences = budgets.maxExperiences;
	}
	if (budgets.maxTokens !== undefined) {
		if (!Number.isInteger(budgets.maxTokens) || budgets.maxTokens <= 0) {
			throw new Error("discovery budgets.max_tokens must be a positive integer");
		}
		result.maxTokens = budgets.maxTokens;
	}
	if (budgets.maxWallTimeMs !== undefined) {
		if (!Number.isFinite(budgets.maxWallTimeMs) || budgets.maxWallTimeMs <= 0) {
			throw new Error("discovery budgets.max_wall_time_ms must be a positive number");
		}
		result.maxWallTimeMs = budgets.maxWallTimeMs;
	}
	if (budgets.maxComputeJobs !== undefined) {
		if (!Number.isInteger(budgets.maxComputeJobs) || budgets.maxComputeJobs <= 0) {
			throw new Error("discovery budgets.max_compute_jobs must be a positive integer");
		}
		result.maxComputeJobs = budgets.maxComputeJobs;
	}
	return result;
}
