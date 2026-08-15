/**
 * Scoring primitives for discovery experiences.
 *
 * v1 is intentionally simple: objective score direction is per-metric via a
 * direction map, numeric surprise is the relative difference between
 * predicted and observed metrics, novelty is a distance between parameter
 * sets and metric vectors (pluggable later, embeddings etc.). Scores are
 * persisted and search-accessible; they never delete candidates.
 */

import type { ComputeMetricValue, DiscoveryArchiveKind } from "./types.js";

export type MetricDirection = "maximize" | "minimize";

/** Which metric is the primary objective and its direction. */
export interface ScoringConfig {
	/** Primary metric key used for objective score. */
	objectiveMetric?: string;
	/** Per-metric directions. Metrics not listed are ignored by scoring. */
	directions?: Record<string, MetricDirection>;
	/** Weight of novelty in the composite score, 0..1. */
	noveltyWeight?: number;
	/** Weight of surprise in the composite score, 0..1. */
	surpriseWeight?: number;
}

function numericValue(value: ComputeMetricValue | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Objective score for a set of metrics. Normalized to [0, 1] against a
 * reference set (typically the campaign baseline, or the incumbent elites).
 * Returns undefined when no numeric metric has a known direction.
 */
export function objectiveScore(
	metrics: Record<string, ComputeMetricValue>,
	reference: Record<string, ComputeMetricValue>,
	config: ScoringConfig,
): number | undefined {
	const directions = config.directions ?? {};
	const keys = Object.keys(directions).filter((key) => numericValue(metrics[key]) !== undefined);
	if (keys.length === 0) {
		return undefined;
	}
	let total = 0;
	let weightSum = 0;
	for (const key of keys) {
		const direction = directions[key];
		const value = numericValue(metrics[key])!;
		const referenceValue = numericValue(reference[key]);
		const weight = key === config.objectiveMetric ? 2 : 1;
		weightSum += weight;
		if (referenceValue === undefined || referenceValue === 0) {
			total += weight * 0.5;
			continue;
		}
		// Fractional improvement over the reference, clamped to a sane band.
		const improvement =
			direction === "minimize"
				? (referenceValue - value) / Math.abs(referenceValue)
				: (value - referenceValue) / Math.abs(referenceValue);
		total += weight * clamp01(0.5 + improvement / 2);
	}
	return total / weightSum;
}

export interface SurpriseInput {
	predicted?: Record<string, ComputeMetricValue>;
	observed: Record<string, ComputeMetricValue>;
	/** Structural surprise: agent-declared reason, already scored or not. */
	reasonSurprising?: string;
	declaredScore?: number;
}

/**
 * Numeric surprise: mean absolute relative error between predicted and
 * observed metrics. Falls back to a declared (agent/evaluator-supplied)
 * score when no numeric prediction exists.
 */
export function numericSurprise(input: SurpriseInput): number {
	const predicted = input.predicted ?? {};
	const pairs = Object.keys(predicted).filter(
		(key) => numericValue(predicted[key]) !== undefined && numericValue(input.observed[key]) !== undefined,
	);
	if (pairs.length > 0) {
		let total = 0;
		for (const key of pairs) {
			const expected = numericValue(predicted[key])!;
			const actual = numericValue(input.observed[key])!;
			if (expected === 0) {
				total += actual === 0 ? 0 : 1;
			} else {
				total += Math.min(1, Math.abs(actual - expected) / Math.abs(expected));
			}
		}
		const mean = total / pairs.length;
		// Blend: numeric surprise dominates, but an explicit agent reason
		// ("this violates an expected relationship") strengthens it.
		const declared = clamp01(input.declaredScore ?? (input.reasonSurprising ? 0.5 : 0));
		return clamp01(0.7 * mean + 0.3 * declared);
	}
	return clamp01(input.declaredScore ?? (input.reasonSurprising ? 0.6 : 0));
}

export interface NoveltyInput {
	params?: Record<string, ComputeMetricValue>;
	metrics?: Record<string, ComputeMetricValue>;
	/** Already-known candidates to compute distance against. */
	known: Array<{ params?: Record<string, ComputeMetricValue>; metrics?: Record<string, ComputeMetricValue> }>;
	/** Declared operator set, e.g. ["change_representation"]. */
	operators?: string[];
}

/**
 * Novelty: 1 - similarity to the nearest known candidate. Similarity is the
 * average of normalized parameter distance and normalized metric-vector
 * distance when both are available; operator novelty ("nobody has used this
 * representation") adds a small bonus. Plug in embeddings later without
 * changing callers.
 */
export function noveltyScore(input: NoveltyInput): number {
	if (input.known.length === 0) {
		return 1;
	}
	const params = numericEntries(input.params ?? {});
	const metrics = numericEntries(input.metrics ?? {});
	if (params.length === 0 && metrics.length === 0) {
		const operators = new Set(input.operators ?? []);
		const operatorNovel =
			operators.size > 0 &&
			[...operators].some(
				(op) => op === "change_representation" || op === "change_objective" || op === "counterexample_search",
			);
		return operatorNovel ? 0.8 : 0.5;
	}
	let nearestSimilarity = 0;
	for (const known of input.known) {
		const similarities: number[] = [];
		const knownParams = numericEntries(known.params ?? {});
		if (params.length > 0 && knownParams.length > 0) {
			similarities.push(1 - normalizedDistance(params, knownParams));
		}
		const knownMetrics = numericEntries(known.metrics ?? {});
		if (metrics.length > 0 && knownMetrics.length > 0) {
			similarities.push(1 - normalizedDistance(metrics, knownMetrics));
		}
		if (similarities.length === 0) {
			continue;
		}
		const similarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
		nearestSimilarity = Math.max(nearestSimilarity, similarity);
	}
	return clamp01(1 - nearestSimilarity);
}

/** Composite experience score blending objective, novelty, and surprise. */
export function compositeScore(
	objective: number | undefined,
	novelty: number | undefined,
	surprise: number | undefined,
	config: ScoringConfig,
): number {
	const noveltyWeight = clamp01(config.noveltyWeight ?? 0.15);
	const surpriseWeight = clamp01(config.surpriseWeight ?? 0.1);
	const objectiveWeight = 1 - noveltyWeight - surpriseWeight;
	let total = 0;
	let weightSum = 0;
	if (objective !== undefined) {
		total += objectiveWeight * objective;
		weightSum += objectiveWeight;
	}
	if (novelty !== undefined) {
		total += noveltyWeight * novelty;
		weightSum += noveltyWeight;
	}
	if (surprise !== undefined) {
		total += surpriseWeight * surprise;
		weightSum += surpriseWeight;
	}
	return weightSum === 0 ? 0 : clamp01(total / weightSum);
}

/**
 * Assign archives for a completed experience. Membership is additive: an
 * experience may belong to several archives and never gets deleted for
 * scoring poorly.
 */
export function assignArchives(input: {
	objective: number | undefined;
	novelty: number | undefined;
	surprise: number | undefined;
	valid: boolean;
	/** True when this is currently the best objective score in the campaign. */
	bestSoFar: boolean;
	/** True when this is the most novel known candidate. */
	novelestSoFar: boolean;
	/** True when this is the most surprising known result. */
	mostSurprisingSoFar: boolean;
	/** True when the experience failed but the failure carries notes/rationale. */
	informativeFailure: boolean;
}): DiscoveryArchiveKind[] {
	const archives: DiscoveryArchiveKind[] = [];
	// Elite membership requires validity: an invalid measurement is not an
	// improvement no matter how fast it looks.
	if (input.bestSoFar && input.objective !== undefined && input.valid) {
		archives.push("elite");
	}
	if (input.novelestSoFar || (input.novelty !== undefined && input.novelty >= 0.8)) {
		archives.push("novelty");
	}
	if (input.mostSurprisingSoFar || (input.surprise !== undefined && input.surprise >= 0.7)) {
		archives.push("surprise");
	}
	if (input.informativeFailure || (!input.valid && input.surprise !== undefined && input.surprise >= 0.5)) {
		archives.push("failure");
	}
	return archives;
}

function numericEntries(values: Record<string, ComputeMetricValue>): Array<[string, number]> {
	return Object.entries(values).filter((entry): entry is [string, number] => numericValue(entry[1]) !== undefined);
}

/** Average absolute normalized difference over shared numeric keys. */
function normalizedDistance(a: Array<[string, number]>, b: Array<[string, number]>): number {
	const map = new Map(b);
	const shared = a.filter(([key]) => map.has(key));
	if (shared.length === 0) {
		return 1;
	}
	let total = 0;
	for (const [key, value] of shared) {
		const other = map.get(key)!;
		const range = Math.max(1e-9, Math.abs(value), Math.abs(other));
		total += Math.min(1, Math.abs(value - other) / range);
	}
	return total / shared.length;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}
