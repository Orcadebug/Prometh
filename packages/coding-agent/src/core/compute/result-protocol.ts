/**
 * Machine-readable result protocol for executable experiments.
 *
 * A process can emit a result object on stdout (or into a designated result
 * file) using the `prime_discovery_result` JSON convention:
 *
 *   {
 *     "prime_discovery_result": {
 *       "metrics": { "accuracy": 0.948, "latency_ms": 109.4 },
 *       "valid": true,
 *       "notes": "..."
 *     }
 *   }
 *
 * The parser is deliberately tolerant: it accepts a bare metrics object and
 * ignores trailing garbage after the closing brace. Malformed output never
 * fails the job; it simply leaves `structuredResult` unset.
 */

import { readFileSync } from "node:fs";
import type { ComputeMetricValue, StructuredResult } from "./types.js";

export const RESULT_OBJECT_KEY = "prime_discovery_result";

function isMetricValue(value: unknown): value is ComputeMetricValue {
	return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
}

function normalizeMetrics(value: unknown): Record<string, ComputeMetricValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const metrics: Record<string, ComputeMetricValue> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (isMetricValue(entry)) {
			metrics[key] = entry;
		}
	}
	return metrics;
}

/**
 * Parse a structured result from raw text. Returns undefined when the text
 * does not contain a well-formed result object. Never throws.
 */
export function parseStructuredResult(text: string): StructuredResult | undefined {
	const start = text.indexOf("{");
	if (start < 0) {
		return undefined;
	}
	// Scan for the last balanced top-level closing brace starting from `start`.
	const end = lastBalancedBraceEnd(text, start);
	if (end === undefined) {
		return undefined;
	}
	const candidate = text.slice(start, end + 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	let payload: unknown = record;
	if (record[RESULT_OBJECT_KEY] !== undefined) {
		if (typeof record[RESULT_OBJECT_KEY] !== "object" || record[RESULT_OBJECT_KEY] === null) {
			return undefined;
		}
		payload = record[RESULT_OBJECT_KEY];
	}
	const result = payload as Record<string, unknown>;
	if (typeof result !== "object" || result === null) {
		return undefined;
	}
	const metrics = normalizeMetrics(result.metrics);
	if (Object.keys(metrics).length === 0) {
		return undefined;
	}
	return {
		metrics,
		valid: typeof result.valid === "boolean" ? result.valid : true,
		notes: typeof result.notes === "string" ? result.notes.slice(0, 2000) : undefined,
		predicted_metrics:
			typeof result.predicted_metrics === "object" && result.predicted_metrics !== null
				? normalizeMetrics(result.predicted_metrics)
				: undefined,
		extra:
			typeof result.extra === "object" && result.extra !== null && !Array.isArray(result.extra)
				? (result.extra as Record<string, unknown>)
				: undefined,
	};
}

/** Find the end index of the last balanced JSON object opening at `start`. */
function lastBalancedBraceEnd(text: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastEnd: number | undefined;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				lastEnd = i;
			}
		}
	}
	return lastEnd;
}

/** Parse a structured result from a result file, tolerating a missing/unreadable file. */
export function parseStructuredResultFile(path: string): StructuredResult | undefined {
	try {
		return parseStructuredResult(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}
