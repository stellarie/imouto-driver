# imouto-driver

A minimal MCP server that runs DeepSeek worker agents ("imoutos").
Any MCP client can drive it: Claude Code, Codex, or another agent.

The driver has no built-in process, no predefined roles, and no output contracts.
The orchestrator gives each imouto a goal and a brief at spawn time.
Imoutos use tools, spawn child imoutos, and exchange mail.
The orchestrator can tuck an imouto in (suspend it, state kept) and wake it later.

## Setup

Requires Node 24 and pnpm through corepack.

```sh
corepack pnpm install
corepack pnpm test
```

Environment, from the shell or a `.env` file in the repo root:

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek key. Without it, the driver runs an offline mock. |
| `DEEPSEEK_MODEL` | Model id. Default `deepseek-flash`. |
| `IMOUTO_ROOT` | Project directory. Default: the current directory. |
| `IMOUTO_MEMORY_DIR` | Global memory directory. Default `~/.imouto/memory`. |
| `IMOUTO_EPISODE_TTL_DAYS` | Episode lifetime for `memory_consolidate`. Default 30. |

In the repo `.env`, `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` override the shell environment.
Other `.env` values only fill unset variables, so an MCP client's `IMOUTO_ROOT` still wins.

## Use from Claude Code

```sh
claude mcp add imouto-driver -e IMOUTO_ROOT=<project path> -- corepack pnpm --dir <path to imouto-driver> mcp
```

Orchestrator tools:

| Tool | Purpose |
|---|---|
| `health` | Root, model, live or mock, limits |
| `set_root` | Point the driver at another project directory |
| `spawn` | Start an imouto: `goal`, `brief`, optional `name`, `scope`, `budget` |
| `send` | Mail an imouto |
| `wait` | Receive mail for the orchestrator (max 120 s per call) |
| `status` | Every imouto: state, depth, tokens used and remaining, pending mail |
| `tuck` | Suspend an imouto; its state is kept |
| `wake` | Resume a tucked imouto, with optional text and extra budget |
| `run_gates` | Run the root's `typecheck`, `lint`, `build`, and `test` scripts |
| `search` | Full-text search over memory, episodes, mail, and Markdown docs |
| `memory_read` | Read a fact or candidate with its evidence |
| `memory_candidates` | List candidates with support and promotability |
| `memory_promote` | Promote a candidate to a fact |
| `memory_reject` | Reject a candidate with a reason |
| `memory_forget` | Delete a fact |
| `memory_consolidate` | Prune old episodes; list promotable, contested, and stale items |

Imouto tools: `fs`, `shell`, `grep`, `web` (fetch only), `view_image`, `run_gates`, `spawn`, `send`, `wait`,
`search`, `memory_recall`, `memory_read`, `memory_note`.

## Memory

Memory grows slowly, in three layers:

1. **Episodes.** The driver records every finished activation. No LLM is involved.
2. **Candidates.** Imoutos call `memory_note` with evidence. Others add support with `supports`, or dispute a fact with `contests`.
3. **Facts.** Only the orchestrator promotes. A candidate needs evidence from 2 episodes, or 1 executed proof.

Imoutos see the fact index in their system prompt. Facts live as Markdown in `<root>/.imouto/memory/facts/` (project) and the global memory directory.

Search is SQLite FTS5 with BM25 ranking. There are no embeddings.

## Watch the imoutos think

```sh
corepack pnpm watch                  # follow .imouto/events.jsonl live
corepack pnpm watch --id imo-2       # one imouto
corepack pnpm watch --no-reasoning   # hide reasoning
corepack pnpm watch --from-start     # replay the whole log
```

Set `IMOUTO_ROOT` to watch a project other than the current directory.

## Scripts

| Script | Purpose |
|---|---|
| `probe` | Live two-round tool loop against DeepSeek |
| `smoke` | Live run: one root imouto, one child, mail back to the orchestrator |
| `mcp` | Start the MCP server on stdio |
| `watch` | Follow the event log |
| `memory-smoke` | Live run: one imouto notes a fact, another verifies and supports it, then it is promoted |

## State

Everything lives in `<root>/.imouto/`:

- `imoutos/<id>.json`: one record per imouto, with its full history.
- `queues.json`: pending mail and the mail id counter.
- `mail.jsonl`: every message sent.
- `events.jsonl`: the live event log.
- `episodes/`: one record per finished activation.
- `memory/`: project candidates, facts, and `MEMORY.md`.
- `search.db`: the full-text index. It is rebuilt from the files above on every start.

After a restart, every imouto loads as tucked. Wake the ones you need.

## Known limits

- `used` counts billed tokens: prompt plus completion for every call. The prompt includes the resent history, so `used` grows faster than the work.
- `shell` runs with `cwd` at the imouto's scope but is not jailed.
- Two imoutos can edit the same file. Give them disjoint scopes.
- Child budgets are not refunded.
- `.imouto/events.jsonl` grows without rotation.

## Backlog

- Skills (stage 3).
- Web search.
- Token-by-token reasoning in the live log.
- Railway deployment with an HTTP transport and key auth.
