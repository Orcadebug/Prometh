/**
 * Host-request bridge for the compute subsystem.
 *
 * Exposes the authoritative ComputeRuntime to the IPython kernel through the
 * existing typed host-request pattern. All validation happens host-side.
 */

import type { HostRequestHandler } from "../kernel/index.js";
import type { ComputeRuntime } from "./runtime.js";
import type { ComputeBackendId, ComputeIsolation, ComputeRequest, ComputeSubmission } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDuration(value: unknown, field: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.trunc(value);
	}
	throw new Error(`${field} must be a positive number of milliseconds`);
}

function readBackend(value: unknown): ComputeBackendId | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "local" || value === "kaggle") {
		return value;
	}
	throw new Error('compute.submit backend must be "local" or "kaggle"');
}

function readIsolation(value: unknown): ComputeIsolation | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "local" || value === "worktree") {
		return value;
	}
	throw new Error('compute.submit isolation must be "local" or "worktree"');
}

export function parseComputeSubmitPayload(payload: Record<string, unknown>): ComputeRequest {
	if (typeof payload.command !== "string" || payload.command.trim().length === 0) {
		throw new Error("compute.submit command must be a non-empty string");
	}
	const request: ComputeRequest = { command: payload.command };
	request.backend = readBackend(payload.backend);
	request.isolation = readIsolation(payload.isolation);
	if (payload.label !== undefined) {
		if (typeof payload.label !== "string") {
			throw new Error("compute.submit label must be a string");
		}
		request.label = payload.label;
	}
	if (payload.accelerator !== undefined) {
		if (typeof payload.accelerator !== "string") {
			throw new Error("compute.submit accelerator must be a string");
		}
		request.accelerator = payload.accelerator;
	}
	if (payload.result_file !== undefined) {
		if (typeof payload.result_file !== "string") {
			throw new Error("compute.submit result_file must be a string");
		}
		request.resultFile = payload.result_file;
	}
	const timeoutMs = readDuration(payload.timeout_ms, "compute.submit timeout_ms");
	if (timeoutMs !== undefined) {
		request.budgets = { ...request.budgets, timeoutMs };
	}
	if (payload.estimated_duration_ms !== undefined) {
		request.estimatedDurationMs = readDuration(payload.estimated_duration_ms, "compute.submit estimated_duration_ms");
	}
	if (payload.files !== undefined) {
		if (!Array.isArray(payload.files) || payload.files.length > 200) {
			throw new Error("compute.submit files must be an array of at most 200 entries");
		}
		request.files = payload.files.map((entry, index) => {
			if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.content !== "string") {
				throw new Error(`compute.submit files[${index}] must have string path and content`);
			}
			return { path: entry.path, content: entry.content };
		});
	}
	if (payload.metadata !== undefined) {
		if (!isRecord(payload.metadata)) {
			throw new Error("compute.submit metadata must be an object");
		}
		request.metadata = payload.metadata;
	}
	return request;
}

function readJobId(payload: Record<string, unknown>, requestType: string): string {
	if (typeof payload.job_id !== "string" || payload.job_id.trim().length === 0) {
		throw new Error(`${requestType} job_id must be a non-empty string`);
	}
	return payload.job_id;
}

export function createComputeHostHandlers(runtime: ComputeRuntime): Record<string, HostRequestHandler> {
	const handlers: Record<string, HostRequestHandler> = {
		"compute.submit": async (payload): Promise<Record<string, unknown>> => {
			const request = parseComputeSubmitPayload(payload);
			const submission: ComputeSubmission = await runtime.submit(request);
			return { job: submission };
		},
		"compute.status": async (payload): Promise<Record<string, unknown>> => {
			const jobId = readJobId(payload, "compute.status");
			return { job: await runtime.status(jobId) };
		},
		"compute.result": async (payload): Promise<Record<string, unknown>> => {
			const jobId = readJobId(payload, "compute.result");
			return { result: await runtime.result(jobId) };
		},
		"compute.list": async (): Promise<Record<string, unknown>> => {
			const jobs = await runtime.list();
			return {
				jobs: jobs.map((job) => ({
					job_id: job.jobId,
					backend: job.backend,
					status: job.status,
					started_at: job.startedAt,
					completed_at: job.completedAt,
					error: job.error,
					label: job.request.label,
					metrics: job.result?.metrics ?? {},
				})),
			};
		},
		"compute.cancel": async (payload): Promise<Record<string, unknown>> => {
			const jobId = readJobId(payload, "compute.cancel");
			await runtime.cancel(jobId);
			return { cancelled: true };
		},
		"compute.budget": async (): Promise<Record<string, unknown>> => {
			return { budget: await runtime.budget() };
		},
	};
	return handlers;
}
