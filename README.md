# Prometh

**Prometh** is an RLM-native terminal coding and research agent built around a persistent IPython kernel, recursive subagents, durable sessions, and a multi-process local runtime. It is a hard fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (MIT), originally descended from [pi-mono](https://github.com/badlogic/pi-mono).

Its signature capability is **compute-driven discovery** — the agent learns by doing: it proposes candidates, executes real computational jobs, observes objective results, preserves what works *and* what surprises, and uses those observations to decide what to try next.

```text
propose -> execute -> observe -> preserve -> reinterpret -> propose again
```

## Quick Start

Clone and run:

```bash
git clone https://github.com/Orcadebug/Prometh.git
cd Prometh
npm install
./prometh.sh
```

Or install from the release installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Orcadebug/Prometh/main/install.sh | sh
prometh
```

Then authenticate with `/login` or set an environment variable such as `ANTHROPIC_API_KEY` before launch.

**Requirements:** Node.js 22.8+, npm, and (for Python skills) `uv` or an existing Python 3.11+ environment with `ipykernel`.

> [!WARNING]
> Prometh executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only.

## Browser Automation (open-claude-in-chrome)

Prometh ships with a built-in TCP bridge to a vendored copy of
[open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome)
(by [Noemica](https://noemica.io), MIT-style "clean-room reimplementation"
of Anthropic's browser extension; this distribution includes it under the
**PolyForm Noncommercial License 1.0.0** — see `LICENSE` and
`extensions/open-claude-in-chrome/LICENSE`). When you launch Prometh with
`--chrome-bridge`, the agent can drive any Chromium browser through 26 tools
— `navigate`, `computer`, `read_page`, `find`, `form_input`, `javascript_tool`,
`read_console_messages`, `read_network_requests`, and more — all with no
domain blocklist and no separate MCP server process.

### One-time setup

1. Install the vendored extension into your Chromium browser:
   ```bash
   ./extensions/open-claude-in-chrome/install.sh <your-extension-id>
   ```
   (Open `chrome://extensions`, enable Developer mode, "Load unpacked" the
   `extensions/open-claude-in-chrome/extension/` folder, then copy the
   extension ID shown under the extension name.)
2. Restart the browser.

### Use

```bash
./prometh.sh --chrome-bridge
```

Then ask the agent anything web-shaped: *"Open Hacker News and summarize the
top five stories"*, *"Sign in to GitHub and star this repo"*, *"Fill out the
form at https://example.com and click submit"*. The agent talks to the
extension over `127.0.0.1:18765` — no extra daemons, no MCP plumbing.

For configuration (`port`, `host`, `autoStart`, `requestTimeoutMs`), see
[packages/coding-agent/docs/chrome-bridge.md](packages/coding-agent/docs/chrome-bridge.md).
The upstream `execute_code` and code-mode sandbox are **not** started by
Prometh; if you need them, run the OCIC `server-hybrid.js` separately.

## Compute-Driven Discovery

The headline feature of this fork. Prometh doesn't get smarter just because compute is available — it turns execution into experience.

### The loop

1. **Create a campaign** with an objective and explicit budgets.
2. **Set a baseline** — a passing exit code is not evidence of improvement.
3. **Propose candidates** with hypotheses, predicted metrics, operators, and lineage.
4. **Execute real jobs** through the bounded compute subsystem (local subprocesses by default; optional Kaggle CLI backend).
5. **Observe results** — parsed via a machine-readable result protocol, never stuffed raw into context.
6. **Preserve** the best, the novel, the surprising, and the informatively failing candidates in four additive archives. Losers are never deleted.
7. **Replicate winners** across seeds, then **complete** only when evidence is strong.

```python
# From IPython
campaign = await discovery.create(
    objective="Reduce latency while preserving correctness",
    budgets={"max_compute_jobs": 200, "max_wall_time_ms": 6 * 3600 * 1000},
)
await discovery.set_baseline(campaign["campaign"]["id"], metrics={"latency_ms": 142})

candidate = await discovery.add_candidate(
    campaign["campaign"]["id"],
    hypothesis="Closed-form arithmetic removes the loop entirely",
    intervention={"command": "python bench.py fast_sum", "files": [{"path": "bench.py", "content": "..."}]},
    predicted_metrics={"latency_ms": 5},
    operators=["change_representation"],
)

await discovery.replicate(campaign["campaign"]["id"], candidate["experience"]["id"], seeds=[1, 2, 3])
summary = await discovery.summarize(campaign["campaign"]["id"])
await discovery.complete(campaign["campaign"]["id"])
```

Validated discoveries can be persisted as reusable lessons through `/refine`, with machine-readable provenance (`source: "discovery"`, campaign id, experience ids, replication count, validation status). One lucky run never becomes global harness state.

### The compute subsystem

- **Bounded local backend** — wall-clock timeouts, output-size caps, concurrency limits, cancellation, per-job working directories.
- **Optional Kaggle backend** — orchestrates kernel scripts through the official Kaggle CLI when installed and authenticated; degrades cleanly otherwise. No credentials are hard-coded or logged.
- **Disposable git worktrees** — repository-changing experiments can request `isolation: "worktree"` so parallel candidates never corrupt the same checkout.
- **Durable job state** — every job has a durable id and survives session continuation under the session artifact directory.
- **Result protocol** — experiments emit `{"prime_discovery_result": {"metrics": {...}, "valid": true}}` on stdout or into a result file; the host parses it into searchable metrics.

### `compute` skill

```python
job = await compute.submit("python bench.py --variant A", timeout_ms=120000)
result = await compute.result(job["job"]["jobId"])
budget = await compute.budget()
```

### `/discovery` command

```text
/discovery start <objective>
/discovery status
/discovery pause <campaign-id>
/discovery resume <campaign-id>
/discovery stop <campaign-id>
```

### Autonomous mode

Active campaigns within budget produce bounded continuation turns in autonomous mode; exhausted campaigns stop cleanly. Existing autonomous limits (continuations, turns, tokens, wall clock, quality gates) remain authoritative.

Read the full design document: [packages/coding-agent/docs/compute-discovery.md](packages/coding-agent/docs/compute-discovery.md).
Run the end-to-end demo (no GPU, no API keys): `cd packages/coding-agent && npx tsx examples/compute-discovery-demo.ts`.

## What Prometh Keeps From Its Base

- A persistent **IPython kernel** as the model-facing environment; Python-backed skills over the typed `rlm.host_request` bridge.
- **RLM child agents** for independent delegated work.
- Durable **sessions** with branching, compaction, and tree navigation.
- **Slash commands** (`/goal`, `/refine`, `/autonomous`, `/heartbeat`, …), prompt templates, skills, extensions, themes, MCP integrations.
- **Continual harness** (`/refine`) for persistent memories, skills, subagent specs, and prompt notes.
- **Long-running work**: daemon-backed background agents, direct agent-to-agent messaging, heartbeats, schedules, persistent goals, bounded autonomous mode.

## Documentation

- [Full docs index](packages/coding-agent/docs/index.md)
- [Compute-driven discovery](packages/coding-agent/docs/compute-discovery.md)
- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [Usage and CLI reference](packages/coding-agent/docs/usage.md)
- [RLM programming model](packages/coding-agent/docs/rlm.md)
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md)

## Development

```bash
npm run check   # format, lint, typecheck
./test.sh       # run the test suite
```

## Acknowledgements

Prometh is a fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) by Prime Intellect, which is itself built on [`pi`](https://github.com/earendil-works/pi) and [pi-mono](https://github.com/badlogic/pi-mono). We thank the authors of `pi` and Prime Agent for their valuable work.

## License

MIT. Prometh is a fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (Copyright (c) 2025 Mario Zechner, Copyright (c) 2026 Prime Intellect), descended from [pi-mono](https://github.com/badlogic/pi-mono). All original license and attribution remain intact. Prometh-specific changes are Copyright (c) 2026 Orca and contributors, under the same MIT license.
