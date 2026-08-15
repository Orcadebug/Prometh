/**
 * Autonomous-mode integration for compute-driven discovery campaigns.
 *
 * An active campaign within budget warrants another turn; a budget-limited
 * campaign must not spin. Existing autonomous limits (continuations, turns)
 * continue to bound the loop.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.js";

describe("discovery autonomous integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("continues while a discovery campaign is active and within budget", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2 },
			includeDiscovery: true,
			persistSession: true,
		});
		harnesses.push(harness);
		const engine = harness.session.discoveryEngine;
		expect(engine).toBeDefined();
		const campaign = await engine!.createCampaign({ objective: "reduce latency" });
		expect(engine!.hasContinuableWork()).toBe(true);

		harness.setResponses([
			fauxAssistantMessage("I created a campaign."),
			fauxAssistantMessage("Campaign still active, continuing."),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("run a discovery campaign");

		// The discovery continuation message must reference the active campaign.
		const userTexts = getUserTexts(harness);
		expect(userTexts.some((text) => text.includes(campaign.id))).toBe(true);
	});

	it("does not continue forever once the campaign budget is exhausted", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2 },
			includeDiscovery: true,
			persistSession: true,
		});
		harnesses.push(harness);
		const engine = harness.session.discoveryEngine;
		const campaign = await engine!.createCampaign({
			objective: "reduce latency",
			budgets: { maxExperiences: 1 },
		});
		await engine!.recordExperience({
			campaignId: campaign.id,
			intervention: { command: "true" },
		});
		expect(engine!.hasContinuableWork()).toBe(false);

		harness.setResponses([fauxAssistantMessage("Campaign budget done.")]);
		await harness.session.prompt("run a discovery campaign");

		// No discovery continuation should be queued for an exhausted campaign.
		const userTexts = getUserTexts(harness);
		expect(userTexts.filter((text) => text.includes("still has budget remaining"))).toHaveLength(0);
	});

	it("respects existing autonomous continuation limits with discovery active", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
			includeDiscovery: true,
			persistSession: true,
		});
		harnesses.push(harness);
		const engine = harness.session.discoveryEngine;
		await engine!.createCampaign({ objective: "reduce latency" });

		harness.setResponses([fauxAssistantMessage("Working on the campaign."), fauxAssistantMessage("Still working.")]);
		await harness.session.prompt("run a discovery campaign");

		const status = harness.session.getAutonomousStatus();
		expect(status.continuationsUsed).toBeLessThanOrEqual(status.limits.maxContinuations);
	});

	it("leaves autonomous behavior unchanged when discovery is disabled", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
			includeDiscovery: false,
		});
		harnesses.push(harness);
		expect(harness.session.discoveryEngine).toBeUndefined();
		harness.setResponses([
			fauxAssistantMessage("Should I continue?"),
			fauxAssistantMessage("Continuing without discovery."),
		]);
		await harness.session.prompt("work on something");
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});
});
