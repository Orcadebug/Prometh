/**
 * Disposable git worktree isolation for repository-changing experiments.
 *
 * Each job gets its own `git worktree add` directory so parallel candidates
 * never mutate the same checkout. Worktrees are created from the current
 * repository HEAD (plus optionally a candidate branch) and are removed when
 * the runtime disposes.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeOptions {
	/** Repository root the worktree is created from. */
	repoDir: string;
	/** Root directory where worktrees are created. */
	worktreeRootDir: string;
	/** Optional branch to check out in the worktree; defaults to current HEAD. */
	branch?: string;
	/** Optional signal to abort creation. */
	signal?: AbortSignal;
}

export interface WorktreeHandle {
	/** Absolute path of the worktree checkout. */
	path: string;
	/** Cleanup: remove the worktree via `git worktree remove --force`. */
	cleanup: () => void;
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
	});
	return {
		ok: result.status === 0 && !result.error,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function isGitRepository(dir: string): boolean {
	return runGit(["rev-parse", "--is-inside-work-tree"], dir).ok;
}

/**
 * Create a disposable worktree. Throws when git is unavailable, the
 * directory is not a repository, or the worktree cannot be created.
 */
export function createWorktree(options: WorktreeOptions): WorktreeHandle {
	options.signal?.throwIfAborted();
	if (!isGitRepository(options.repoDir)) {
		throw new Error(`worktree isolation requires a git repository at ${options.repoDir}`);
	}
	mkdirSync(options.worktreeRootDir, { recursive: true });
	const id = `exp_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const path = join(options.worktreeRootDir, id);
	const result = runGit(["worktree", "add", "--detach", path], options.repoDir);
	if (!result.ok) {
		throw new Error(`git worktree add failed: ${result.stderr.trim().slice(0, 400)}`);
	}
	return {
		path,
		cleanup: () => {
			runGit(["worktree", "remove", "--force", path], options.repoDir);
			if (existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		},
	};
}
