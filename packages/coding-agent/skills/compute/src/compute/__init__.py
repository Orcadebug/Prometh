"""Prime Agent compute skill: bounded computational work over the host bridge.

All job state, budgets, and lifecycle live in the TypeScript host; these
functions are thin typed wrappers over the generic host bridge
(`rlm.host_request`). They only work inside the Prime Agent IPython kernel.
"""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

Backend = Literal["local", "kaggle"]
Isolation = Literal["local", "worktree"]


async def submit(
    command: str,
    backend: Backend = "local",
    isolation: Isolation = "local",
    timeout_ms: int | None = None,
    label: str | None = None,
    accelerator: str | None = None,
    estimated_duration_ms: int | None = None,
    result_file: str | None = None,
    files: list[dict[str, str]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Submit a bounded compute job.

    Returns a dict with a `job` key carrying the durable `jobId`. The command
    runs in a dedicated job working directory; `files` entries are written
    there first. `isolation="worktree"` runs the job inside a disposable git
    worktree of the session working directory.
    """
    if not isinstance(command, str):
        raise TypeError(f"command must be str, got {type(command).__name__}")
    if backend not in {"local", "kaggle"}:
        raise ValueError('backend must be "local" or "kaggle"')
    if isolation not in {"local", "worktree"}:
        raise ValueError('isolation must be "local" or "worktree"')
    payload: dict[str, Any] = {"command": command, "backend": backend, "isolation": isolation}
    if timeout_ms is not None:
        if not isinstance(timeout_ms, int) or timeout_ms <= 0:
            raise ValueError("timeout_ms must be a positive integer")
        payload["timeout_ms"] = timeout_ms
    if label is not None:
        if not isinstance(label, str):
            raise TypeError(f"label must be str or None, got {type(label).__name__}")
        payload["label"] = label
    if accelerator is not None:
        if not isinstance(accelerator, str):
            raise TypeError(f"accelerator must be str or None, got {type(accelerator).__name__}")
        payload["accelerator"] = accelerator
    if estimated_duration_ms is not None:
        if not isinstance(estimated_duration_ms, int) or estimated_duration_ms <= 0:
            raise ValueError("estimated_duration_ms must be a positive integer")
        payload["estimated_duration_ms"] = estimated_duration_ms
    if result_file is not None:
        if not isinstance(result_file, str):
            raise TypeError(f"result_file must be str or None, got {type(result_file).__name__}")
        payload["result_file"] = result_file
    if files is not None:
        if not isinstance(files, list):
            raise TypeError(f"files must be a list or None, got {type(files).__name__}")
        payload["files"] = files
    if metadata is not None:
        if not isinstance(metadata, dict):
            raise TypeError(f"metadata must be a dict or None, got {type(metadata).__name__}")
        payload["metadata"] = metadata
    return await host_request("compute.submit", payload)


async def status(job_id: str) -> dict[str, Any]:
    """Read the live status of a compute job."""
    if not isinstance(job_id, str):
        raise TypeError(f"job_id must be str, got {type(job_id).__name__}")
    return await host_request("compute.status", {"job_id": job_id})


async def result(job_id: str) -> dict[str, Any]:
    """Block until a compute job finishes and return its full result.

    The result carries `status`, `exit_code`, bounded `stdout`/`stderr`,
    `metrics` (parsed from the result protocol when the job followed it), and
    `structured_result` when present.
    """
    if not isinstance(job_id, str):
        raise TypeError(f"job_id must be str, got {type(job_id).__name__}")
    return await host_request("compute.result", {"job_id": job_id})


async def cancel(job_id: str) -> dict[str, Any]:
    """Cancel a running or pending compute job."""
    if not isinstance(job_id, str):
        raise TypeError(f"job_id must be str, got {type(job_id).__name__}")
    return await host_request("compute.cancel", {"job_id": job_id})


async def list() -> dict[str, Any]:
    """List all compute jobs submitted by this session."""
    return await host_request("compute.list")


async def budget() -> dict[str, Any]:
    """Read compute resource accounting and runtime limits."""
    return await host_request("compute.budget")
