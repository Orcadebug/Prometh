/**
 * Durable persistence for discovery campaigns.
 *
 * Each campaign is persisted as a JSON file under the session artifact
 * directory (following the harness-state convention). The file contains both
 * the campaign record and its experiences so lineage, archives, and results
 * survive normal session continuation. Loads tolerate corruption by
 * returning undefined; the store never throws on read.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputeExperience, DiscoveryCampaign, DiscoveryCampaignStatus } from "./types.js";

const CAMPAIGNS_DIR_NAME = "discovery";

const VALID_STATUSES: readonly DiscoveryCampaignStatus[] = [
	"active",
	"paused",
	"completed",
	"budget_exhausted",
	"failed",
];

export function getDiscoveryStoreDir(sessionArtifactDir: string): string {
	return join(sessionArtifactDir, CAMPAIGNS_DIR_NAME);
}

export function getCampaignFilePath(storeDir: string, campaignId: string): string {
	return join(storeDir, `${campaignId}.json`);
}

export interface PersistedCampaignFile {
	version: 1;
	campaign: DiscoveryCampaign;
	experiences: ComputeExperience[];
}

/** Save a campaign and its experiences atomically. Returns the file path. */
export function saveCampaignFile(
	storeDir: string,
	campaign: DiscoveryCampaign,
	experiences: ComputeExperience[],
): string {
	mkdirSync(storeDir, { recursive: true });
	const filePath = getCampaignFilePath(storeDir, campaign.id);
	const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	const payload: PersistedCampaignFile = { version: 1, campaign, experiences };
	writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
	renameSync(tempPath, filePath);
	return filePath;
}

/** Load a campaign and its experiences; undefined when missing or corrupt. */
export function loadCampaignFile(
	storeDir: string,
	campaignId: string,
): { campaign: DiscoveryCampaign; experiences: ComputeExperience[] } | undefined {
	const filePath = getCampaignFilePath(storeDir, campaignId);
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const record = parsed as Record<string, unknown>;
		const campaign = record.campaign as DiscoveryCampaign | undefined;
		if (typeof campaign !== "object" || campaign === null) {
			return undefined;
		}
		if (typeof campaign.id !== "string" || campaign.id !== campaignId) {
			return undefined;
		}
		if (!VALID_STATUSES.includes(campaign.status)) {
			return undefined;
		}
		const experiences = Array.isArray(record.experiences)
			? (record.experiences as ComputeExperience[]).filter(
					(experience) =>
						typeof experience === "object" && experience !== null && typeof experience.id === "string",
				)
			: [];
		return { campaign, experiences };
	} catch {
		return undefined;
	}
}

/** List ids of persisted campaigns. */
export function listCampaignIds(storeDir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(storeDir);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -".json".length))
		.sort();
}
