---
name: compute
description: Submit, poll, and inspect bounded compute jobs from IPython. Use when experiments, benchmarks, scripts, or any real computational work must run outside the model context, especially for compute-driven discovery campaigns.
---

# Compute

The `compute` skill executes real computational work through the TypeScript
host's provider-neutral compute runtime. Jobs run through bounded backends
(local subprocess by default; optional Kaggle CLI when installed and
authenticated). Job state is durable per session and survives continuation.

Call directly from IPython:

```python
job = await compute.submit(
    command="python experiment.py --variant A",
    backend="local",
    timeout_ms=120000,
    label="variant A",
    metadata={"hypothesis": "variant A reduces memory traffic"},
)
status = await compute.status(job["job"]["jobId"])
result = await compute.result(job["job"]["jobId"])
jobs = await compute.list()
budget = await compute.budget()
```

## API

- `await compute.submit(command, backend="local", isolation="local",
  timeout_ms=None, label=None, accelerator=None, estimated_duration_ms=None,
  result_file=None, files=None, metadata=None)` — submit a job. Returns
  `{"job": {...}}` with a durable `jobId`. `files` is a list of
  `{"path": ..., "content": ...}` entries materialized into the job working
  directory before execution. `isolation="worktree"` runs the job in a
  disposable git worktree (requires a git repository cwd).
- `await compute.status(job_id)` — live job status.
- `await compute.result(job_id)` — block until the job finishes and return the
  full result: exit code, captured stdout/stderr (bounded), metrics, and any
  structured result.
- `await compute.cancel(job_id)` — cancel a running or pending job.
- `await compute.list()` — all jobs submitted by this session.
- `await compute.budget()` — resource accounting and runtime limits.

## Result protocol

Executable experiments should emit a machine-readable result object on stdout:

```json
{"prime_discovery_result": {"metrics": {"accuracy": 0.948, "latency_ms": 109.4}, "valid": true, "notes": "..."}}
```

or write it to a file and pass `result_file="results.json"` to
`compute.submit`. The host parses this into `result["metrics"]` and
`result["structuredResult"]`. Plain command output is always available too.

## Rules

- Local jobs inherit host permissions; this is not a security sandbox.
- Budgets are bounded: concurrency, wall time, output size, and job count are
  enforced by the host.
- Kaggle jobs require the official Kaggle CLI installed and authenticated;
  they degrade to a clean error otherwise.
