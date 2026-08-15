"""Prime Agent discovery skill: compute-driven discovery campaigns.

Campaign state, budgets, lineage, and archives live in the TypeScript host;
these functions are thin typed wrappers over the generic host bridge
(`rlm.host_request`). They only work inside the Prime Agent IPython kernel.
"""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

Validation = Literal["passed", "pending", "failed"]
ArchiveKind = Literal["elite", "novelty", "surprise", "failure"]


async def create(
    objective: str,
    budgets: dict[str, Any] | None = None,
    label: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a discovery campaign.

    `budgets` may contain `max_experiences`, `max_tokens`,
    `max_wall_time_ms`, and `max_compute_jobs`.
    """
    if not isinstance(objective, str):
        raise TypeError(f"objective must be str, got {type(objective).__name__}")
    payload: dict[str, Any] = {"objective": objective}
    if budgets is not None:
        if not isinstance(budgets, dict):
            raise TypeError(f"budgets must be a dict or None, got {type(budgets).__name__}")
        payload["budgets"] = budgets
    if label is not None:
        if not isinstance(label, str):
            raise TypeError(f"label must be str or None, got {type(label).__name__}")
        payload["label"] = label
    if metadata is not None:
        if not isinstance(metadata, dict):
            raise TypeError(f"metadata must be a dict or None, got {type(metadata).__name__}")
        payload["metadata"] = metadata
    return await host_request("discovery.create", payload)


async def status(campaign_id: str) -> dict[str, Any]:
    """Read the current state of a campaign."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.status", {"campaign_id": campaign_id})


async def list() -> dict[str, Any]:
    """List all campaigns in this session."""
    return await host_request("discovery.list")


async def add_candidate(
    campaign_id: str,
    intervention: dict[str, Any],
    hypothesis: str | None = None,
    rationale: str | None = None,
    predicted_metrics: dict[str, Any] | None = None,
    parent_experience_ids: list[str] | None = None,
    operators: list[str] | None = None,
    generation: int | None = None,
    reason_selected: str | None = None,
    metadata: dict[str, Any] | None = None,
    execute: bool = True,
) -> dict[str, Any]:
    """Record a candidate experience and (by default) execute it.

    `intervention` mirrors the compute skill's submit contract: `command`,
    optional `backend`, `isolation`, `timeout_ms`, `files`, `result_file`,
    `accelerator`, `estimated_duration_ms`, and `params` (a structured
    parameter set used for novelty distance).
    """
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    if not isinstance(intervention, dict):
        raise TypeError(f"intervention must be a dict, got {type(intervention).__name__}")
    payload: dict[str, Any] = {"campaign_id": campaign_id, "intervention": intervention}
    if hypothesis is not None:
        if not isinstance(hypothesis, str):
            raise TypeError(f"hypothesis must be str or None, got {type(hypothesis).__name__}")
        payload["hypothesis"] = hypothesis
    if rationale is not None:
        if not isinstance(rationale, str):
            raise TypeError(f"rationale must be str or None, got {type(rationale).__name__}")
        payload["rationale"] = rationale
    if predicted_metrics is not None:
        if not isinstance(predicted_metrics, dict):
            raise TypeError(f"predicted_metrics must be a dict or None, got {type(predicted_metrics).__name__}")
        payload["predicted_metrics"] = predicted_metrics
    if parent_experience_ids is not None:
        if not isinstance(parent_experience_ids, list):
            raise TypeError(f"parent_experience_ids must be a list or None, got {type(parent_experience_ids).__name__}")
        payload["parent_experience_ids"] = parent_experience_ids
    if operators is not None:
        if not isinstance(operators, list):
            raise TypeError(f"operators must be a list or None, got {type(operators).__name__}")
        payload["operators"] = operators
    if generation is not None:
        if not isinstance(generation, int):
            raise TypeError(f"generation must be an int or None, got {type(generation).__name__}")
        payload["generation"] = generation
    if reason_selected is not None:
        if not isinstance(reason_selected, str):
            raise TypeError(f"reason_selected must be str or None, got {type(reason_selected).__name__}")
        payload["reason_selected"] = reason_selected
    if metadata is not None:
        if not isinstance(metadata, dict):
            raise TypeError(f"metadata must be a dict or None, got {type(metadata).__name__}")
        payload["metadata"] = metadata
    payload["execute"] = bool(execute)
    return await host_request("discovery.add_candidate", payload)


async def score(
    campaign_id: str,
    experience_id: str,
    score: float | None = None,
    novelty_score: float | None = None,
    surprise_score: float | None = None,
    validity_score: float | None = None,
    archives: list[ArchiveKind] | None = None,
    surprise: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-score or annotate an experience.

    `surprise` may carry `expected` and `observed` metric dicts,
    `reason_surprising`, and an optional `surprise_score`.
    """
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    if not isinstance(experience_id, str):
        raise TypeError(f"experience_id must be str, got {type(experience_id).__name__}")
    payload: dict[str, Any] = {"campaign_id": campaign_id, "experience_id": experience_id}
    for key, value in (
        ("score", score),
        ("novelty_score", novelty_score),
        ("surprise_score", surprise_score),
        ("validity_score", validity_score),
    ):
        if value is not None:
            if not isinstance(value, (int, float)):
                raise TypeError(f"{key} must be a number or None, got {type(value).__name__}")
            payload[key] = value
    if archives is not None:
        if not isinstance(archives, list):
            raise TypeError(f"archives must be a list or None, got {type(archives).__name__}")
        payload["archives"] = archives
    if surprise is not None:
        if not isinstance(surprise, dict):
            raise TypeError(f"surprise must be a dict or None, got {type(surprise).__name__}")
        payload["surprise"] = surprise
    return await host_request("discovery.score", payload)


async def experiences(campaign_id: str) -> dict[str, Any]:
    """List all experiences recorded for a campaign."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.experiences", {"campaign_id": campaign_id})


async def archives(campaign_id: str) -> dict[str, Any]:
    """Read the four additive archives of a campaign."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.archives", {"campaign_id": campaign_id})


async def set_baseline(
    campaign_id: str,
    metrics: dict[str, Any],
    notes: str | None = None,
) -> dict[str, Any]:
    """Set the baseline metrics an optimization-style campaign compares against."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    if not isinstance(metrics, dict) or not metrics:
        raise ValueError("metrics must be a non-empty dict")
    payload: dict[str, Any] = {"campaign_id": campaign_id, "metrics": metrics}
    if notes is not None:
        if not isinstance(notes, str):
            raise TypeError(f"notes must be str or None, got {type(notes).__name__}")
        payload["notes"] = notes
    return await host_request("discovery.set_baseline", payload)


async def replicate(
    campaign_id: str,
    experience_id: str,
    seeds: list[int | str],
    command_template: str | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """Replicate a completed experience across seeds.

    When `command_template` is given, `{seed}` is substituted per seed;
    otherwise the original command is re-run with `--seed <seed>` appended.
    """
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    if not isinstance(experience_id, str):
        raise TypeError(f"experience_id must be str, got {type(experience_id).__name__}")
    if not isinstance(seeds, list) or not seeds:
        raise ValueError("seeds must be a non-empty list of ints or strings")
    payload: dict[str, Any] = {"campaign_id": campaign_id, "experience_id": experience_id, "seeds": seeds}
    if command_template is not None:
        if not isinstance(command_template, str):
            raise TypeError(f"command_template must be str or None, got {type(command_template).__name__}")
        payload["command_template"] = command_template
    if timeout_ms is not None:
        if not isinstance(timeout_ms, int) or timeout_ms <= 0:
            raise ValueError("timeout_ms must be a positive integer")
        payload["timeout_ms"] = timeout_ms
    return await host_request("discovery.replicate", payload)


async def summarize(campaign_id: str) -> dict[str, Any]:
    """Produce a machine/human-readable campaign summary."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.summarize", {"campaign_id": campaign_id})


async def complete(campaign_id: str) -> dict[str, Any]:
    """Complete a campaign after its objective is validated."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.complete", {"campaign_id": campaign_id})


async def pause(campaign_id: str) -> dict[str, Any]:
    """Pause an active campaign."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.pause", {"campaign_id": campaign_id})


async def resume(campaign_id: str) -> dict[str, Any]:
    """Resume a paused campaign."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.resume", {"campaign_id": campaign_id})


async def budget_status(campaign_id: str) -> dict[str, Any]:
    """Read budget usage and the first exhausted bound, if any."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    return await host_request("discovery.budget_status", {"campaign_id": campaign_id})


async def refinement_provenance(
    campaign_id: str,
    experience_ids: list[str],
    validation: Validation = "passed",
) -> dict[str, Any]:
    """Build validation provenance for persisting a discovery through /refine."""
    if not isinstance(campaign_id, str):
        raise TypeError(f"campaign_id must be str, got {type(campaign_id).__name__}")
    if not isinstance(experience_ids, list):
        raise TypeError(f"experience_ids must be a list, got {type(experience_ids).__name__}")
    if validation not in {"passed", "pending", "failed"}:
        raise ValueError('validation must be "passed", "pending", or "failed"')
    return await host_request(
        "discovery.refinement_provenance",
        {"campaign_id": campaign_id, "experience_ids": experience_ids, "validation": validation},
    )
