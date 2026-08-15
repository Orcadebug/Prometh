---
name: discovery
description: Manage compute-driven discovery campaigns from IPython. Use when the user asks to search, optimize, or discover through real computational experiments — proposing candidates, executing jobs, observing results, preserving archives, and refining hypotheses.
---

# Discovery

The `discovery` skill drives compute-driven discovery campaigns. A campaign is
a durable, bounded search loop: propose candidates → execute real computation
→ observe results → score → preserve elites/novelty/surprise/failures →
propose again. All campaign state, lineage, budgets, and archives live in the
TypeScript host.

```python
campaign = await discovery.create(
    objective="Find a significantly faster implementation without reducing correctness",
    budgets={"max_compute_jobs": 200, "max_wall_time_ms": 6 * 3600 * 1000},
)

await discovery.set_baseline(campaign["campaign"]["id"], metrics={"latency_ms": 142, "accuracy": 0.934})

candidate = await discovery.add_candidate(
    campaign["campaign"]["id"],
    hypothesis="The current layout causes avoidable memory movement",
    intervention={"command": "python bench.py --variant A", "timeout_ms": 120000},
    predicted_metrics={"latency_ms": 120},
    operators=["mutate"],
    parent_experience_ids=[],
)

state = await discovery.status(campaign["campaign"]["id"])
experiences = await discovery.experiences(campaign["campaign"]["id"])
archives = await discovery.archives(campaign["campaign"]["id"])
```

## The loop

1. `create` a campaign with budgets.
2. `set_baseline` with current metrics (run a baseline job first when needed).
3. `add_candidate` for each proposed intervention. Candidates execute through
   the compute subsystem and are scored automatically.
4. Inspect `status`, `experiences`, and `archives` between turns.
5. Use `score` to record surprise (expected vs observed metrics) or override
   archive assignment when the model has better context.
6. `replicate` the best candidate across seeds before trusting it.
7. `summarize` for machine/human-readable output, then `complete` only after
   evidence is strong enough.

## API

- `await discovery.create(objective, budgets=None, label=None, metadata=None)`
- `await discovery.status(campaign_id)` / `await discovery.list()`
- `await discovery.add_candidate(campaign_id, intervention, hypothesis=None,
  rationale=None, predicted_metrics=None, parent_experience_ids=None,
  operators=None, generation=None, reason_selected=None, metadata=None,
  execute=True)` — records a candidate and (by default) executes it.
- `await discovery.score(campaign_id, experience_id, score=None,
  novelty_score=None, surprise_score=None, validity_score=None, archives=None,
  surprise=None)` — re-score or annotate an experience.
- `await discovery.experiences(campaign_id)` / `await discovery.archives(campaign_id)`
- `await discovery.set_baseline(campaign_id, metrics, notes=None)`
- `await discovery.replicate(campaign_id, experience_id, seeds,
  command_template=None, timeout_ms=None)` — re-run a completed experience
  across seeds; `{seed}` in command_template is substituted per seed.
- `await discovery.summarize(campaign_id)` / `await discovery.complete(campaign_id)`
- `await discovery.pause(campaign_id)` / `await discovery.resume(campaign_id)`
- `await discovery.budget_status(campaign_id)`
- `await discovery.refinement_provenance(campaign_id, experience_ids,
  validation="passed")` — provenance for persisting a validated discovery
  through /refine.

## Archives

The host retains candidates by four additive archives; a candidate may belong
to several and is never deleted for scoring poorly:

- `elite` — best objective score so far
- `novelty` — substantially different from known candidates
- `surprise` — unexpected observed vs predicted metrics
- `failure` — informative failures worth remembering

## Rules

- Do not reduce the campaign to hill climbing: preserve novel, surprising, and
  informative failures alongside the best performers.
- The campaign remains bounded: budgets stop the loop cleanly.
- Only call `discovery.complete` after the objective is validated (ideally with
  replications); budget exhaustion is not completion.
