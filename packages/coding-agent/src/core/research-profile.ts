import { join } from "node:path";
import { getBundledSkillsDir } from "../config.js";

export type ResearchProfileName = "research-minimal";

export interface ResearchProfile {
	name: ResearchProfileName;
	capabilities: {
		ipython: true;
		compute: true;
		discovery: true;
		persistence: true;
		evaluator: true;
		recursion: false;
		browser: false;
		mcp: false;
		refinement: false;
		collaboration: false;
		extraSkills: false;
	};
	limits: {
		maxConcurrentJobs: number;
		maxExperiments: number;
		maxWallTimeMs: number;
	};
}

export const RESEARCH_MINIMAL_PROFILE: ResearchProfile = {
	name: "research-minimal",
	capabilities: {
		ipython: true,
		compute: true,
		discovery: true,
		persistence: true,
		evaluator: true,
		recursion: false,
		browser: false,
		mcp: false,
		refinement: false,
		collaboration: false,
		extraSkills: false,
	},
	limits: {
		maxConcurrentJobs: 1,
		maxExperiments: 100,
		maxWallTimeMs: 6 * 60 * 60 * 1000,
	},
};

export function getResearchProfile(name: ResearchProfileName | undefined): ResearchProfile | undefined {
	return name === "research-minimal" ? RESEARCH_MINIMAL_PROFILE : undefined;
}

/** The profile deliberately retains only the skills required for research execution. */
export function getResearchProfileSkillPaths(_profile: ResearchProfile): string[] {
	const skillsDir = getBundledSkillsDir();
	return [join(skillsDir, "compute"), join(skillsDir, "discovery")];
}
