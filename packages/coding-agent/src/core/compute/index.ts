/**
 * Compute subsystem: provider-neutral bounded execution of real
 * computational work, with durable persistence and budget accounting.
 */

export type { ComputeBackend } from "./backends/base.js";
export { KaggleComputeBackend } from "./backends/kaggle.js";
export { LocalComputeBackend } from "./backends/local.js";
export { createComputeHostHandlers, parseComputeSubmitPayload } from "./host-handlers.js";
export { parseStructuredResult, parseStructuredResultFile } from "./result-protocol.js";
export { ComputeRuntime } from "./runtime.js";
export * from "./types.js";
export { createWorktree, isGitRepository } from "./worktree.js";
