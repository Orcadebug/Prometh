/**
 * Discovery subsystem: compute-driven search campaigns.
 *
 * The host persists campaigns, candidates, lineage, archives, budgets, and
 * results; the model proposes interventions and interprets observations.
 */

export { DiscoveryEngine } from "./engine.js";
export { createDiscoveryHostHandlers } from "./host-handlers.js";
export {
	getCampaignFilePath,
	getDiscoveryStoreDir,
	listCampaignIds,
	loadCampaignFile,
	saveCampaignFile,
} from "./persistence.js";
export type { MetricDirection, ScoringConfig } from "./scoring.js";
export { assignArchives, compositeScore, noveltyScore, numericSurprise, objectiveScore } from "./scoring.js";
export * from "./types.js";
