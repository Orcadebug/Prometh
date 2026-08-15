/**
 * Provider-neutral compute backend contract.
 */

import type { ComputeJobStatusSnapshot, ComputeRequest, ComputeResult, ComputeSubmission } from "../types.js";

export interface ComputeBackend {
	/** Stable backend id, e.g. "local" or "kaggle". */
	readonly id: string;
	/** Human-readable backend name for summaries. */
	readonly label: string;

	/** Whether this backend can currently execute jobs (no credential check side effects beyond a probe). */
	available(): Promise<boolean>;

	/** Submit a job for execution. Resolves once the job is accepted. */
	submit(request: ComputeRequest): Promise<ComputeSubmission>;

	/** Poll live job status. */
	status(jobId: string): Promise<ComputeJobStatusSnapshot>;

	/** Wait for a job to finish and return its result. */
	result(jobId: string): Promise<ComputeResult>;

	/** Cancel a running or pending job. Optional; throws when unsupported. */
	cancel?(jobId: string): Promise<void>;

	/** Tear down the backend, cancelling any in-flight jobs. Optional. */
	dispose?(): void;
}

/** Factory for constructing backends; lets the runtime own backend lifecycle. */
export type ComputeBackendFactory = () => ComputeBackend;
