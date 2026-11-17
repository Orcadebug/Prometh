import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getResearchProfile,
	getResearchProfileSkillPaths,
	RESEARCH_MINIMAL_PROFILE,
} from "../src/core/research-profile.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("research-minimal profile", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path) rmSync(path, { recursive: true, force: true });
		}
	});

	it("declares bounded research capabilities and only the required bundled skills", () => {
		expect(getResearchProfile("research-minimal")).toBe(RESEARCH_MINIMAL_PROFILE);
		expect(RESEARCH_MINIMAL_PROFILE.capabilities).toMatchObject({
			ipython: true,
			compute: true,
			discovery: true,
			recursion: false,
			browser: false,
			mcp: false,
			refinement: false,
			collaboration: false,
			extraSkills: false,
		});
		expect(getResearchProfileSkillPaths(RESEARCH_MINIMAL_PROFILE).map((path) => path.split("/").at(-1))).toEqual([
			"compute",
			"discovery",
		]);
	});

	it("exposes only IPython, compute, and discovery to a direct SDK session", async () => {
		const root = join(tmpdir(), `prometh-research-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		cleanupPaths.push(root);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			researchProfile: "research-minimal",
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.create(root, join(root, "sessions")),
		});
		try {
			expect(session.getActiveToolNames()).toEqual(["ipython"]);
			const skills = (
				session as unknown as { _modelVisibleSkills(): Array<{ name: string }> }
			)._modelVisibleSkills();
			expect(skills.map((skill) => skill.name)).toEqual(["compute", "discovery"]);
			const handlers = (
				session as unknown as { _createKernelHostHandlers(): Record<string, unknown> }
			)._createKernelHostHandlers();
			expect(handlers).toHaveProperty("compute.submit");
			expect(handlers).toHaveProperty("discovery.create");
			expect(handlers).not.toHaveProperty("mcp.refresh");
			expect(handlers).not.toHaveProperty("refine.run");
			expect(handlers).not.toHaveProperty("rlm.run");
			const budget = await session.computeRuntime?.budget();
			expect(budget?.limits).toMatchObject({ maxConcurrency: 1, maxJobs: 100, maxWallTimeMs: 6 * 60 * 60 * 1000 });
		} finally {
			session.dispose();
		}
	});

	it("rejects extension points that could re-enable disabled capabilities", async () => {
		await expect(
			createAgentSession({
				researchProfile: "research-minimal",
				resourceLoader: {} as never,
			}),
		).rejects.toThrow("restricted resource loader");
	});
});
