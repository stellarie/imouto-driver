# imouto-driver

A minimal MCP server that runs DeepSeek worker agents ("imoutos").
Any MCP client can drive it: Claude Code, Codex, or another agent.

The driver has no built-in process, no predefined roles, and no output contracts.
The orchestrator gives each imouto a goal and a brief at spawn time.
Imoutos use tools, spawn child imoutos, exchange mail, remember findings, and use skills.
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
| `IMOUTO_SKILLS_DIR` | Global skills directory. Default `~/.imouto/skills`. |
| `IMOUTO_EPISODE_TTL_DAYS` | Episode lifetime for `memory_consolidate`. Default 30. |

In the repo `.env`, `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` override the shell environment.
Other `.env` values only fill unset variables, so an MCP client's `IMOUTO_ROOT` still wins.

## Use from Claude Code

Register the server once per project, from inside that project:

```sh
claude mcp add imouto-driver -e IMOUTO_ROOT=<project path> -- <node path> <imouto-driver>/node_modules/tsx/dist/cli.mjs <imouto-driver>/src/mcp.ts
```

Point the command at `node` directly. On Windows, MCP clients often cannot start `.cmd` shims such as `corepack`.
Add `.imouto/` to the project's `.git/info/exclude`.

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
| `search` | Full-text search over memory, episodes, mail, skills, and Markdown docs |
| `memory_read` | Read a fact or candidate with its evidence |
| `memory_candidates` | List candidates with support and promotability |
| `memory_promote` | Promote a candidate to a fact |
| `memory_reject` | Reject a candidate with a reason |
| `memory_forget` | Delete a fact |
| `memory_consolidate` | Prune old episodes; list promotable, contested, and stale items, and skill suggestions |
| `skill_list` | List promoted skills |
| `skill_read` | Read a skill |
| `skill_drafts` | Review skill drafts with evidence and full text |
| `skill_promote` | Promote a draft; an older skill of that name moves to `versions/` |
| `skill_reject` | Reject a draft with a reason |

Imouto tools: `fs`, `shell`, `grep`, `web` (fetch only), `view_image`, `run_gates`, `spawn`, `send`, `wait`,
`search`, `memory_recall`, `memory_read`, `memory_note`, `skill_list`, `skill_read`, `skill_draft`.

## Memory

Memory grows slowly, in three layers:

1. **Episodes.** The driver records every finished activation. No LLM is involved.
2. **Candidates.** Imoutos call `memory_note` with evidence. Others add support with `supports`, or dispute a fact with `contests`.
3. **Facts.** Only the orchestrator promotes. A candidate needs evidence from 2 episodes, or 1 executed proof.

Imoutos see the fact index in their system prompt. Facts live as Markdown in `<root>/.imouto/memory/facts/` (project) and the global memory directory.
Edit a fact body at promotion when supporting evidence corrected the claim.

Search is SQLite FTS5 with BM25 ranking. There are no embeddings.

## Skills

A skill is a reusable procedure: `<name>/SKILL.md` with `name` and `description` frontmatter and a Markdown body.

- Imoutos see only the skill index in their system prompt. They load a body with `skill_read`.
- Imoutos propose skills with `skill_draft`, with evidence of where the procedure worked. Only the orchestrator promotes.
- Project skills live in `<root>/.imouto/skills/`; global skills in the global skills directory. A project skill wins on a name clash.
- `memory_consolidate` suggests a skill when 3 or more `procedure` facts share a tag.

To add a skill by hand, create `<skills dir>/<name>/SKILL.md`:

```markdown
---
name: run-rust-tests
description: Run the workspace tests the way CI does
---

1. ...
```

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
| `typecheck` | `tsc --noEmit` |
| `test` | The offline test suite |
| `mcp` | Start the MCP server on stdio |
| `watch` | Follow the event log |
| `probe` | Live two-round tool loop against DeepSeek |
| `smoke` | Live run: one root imouto, one child, mail back to the orchestrator |
| `memory-smoke` | Live run: one imouto notes a fact, another verifies and supports it, then it is promoted |
| `skills-smoke` | Live run: one imouto drafts a skill, it is promoted, another imouto reads and follows it |

## State

Everything lives in `<root>/.imouto/`:

- `imoutos/<id>.json`: one record per imouto, with its full history.
- `queues.json`: pending mail and the mail id counter.
- `mail.jsonl`: every message sent.
- `events.jsonl`: the live event log.
- `episodes/`: one record per finished activation.
- `memory/`: project candidates, facts, and `MEMORY.md`.
- `skills/`: project skills and drafts.
- `search.db`: the full-text index. It is rebuilt from the files above on every start.

After a restart, every imouto loads as tucked. Wake the ones you need.

## Known limits

- `used` counts billed tokens: prompt plus completion for every call. The prompt includes the resent history, so `used` grows faster than the work.
- `shell` runs with `cwd` at the imouto's scope but is not jailed. Imoutos have used it to leave their scope.
- Two imoutos can edit the same file. Give them disjoint scopes.
- Child budgets are not refunded.
- `.imouto/events.jsonl` grows without rotation.
- A fact or skill promoted mid-activation reaches an imouto at its next activation.

## Backlog

- Web search.
- Token-by-token reasoning in the live log.
- Railway deployment with an HTTP transport and key auth.
- Seeding skills, such as the how-claude-thinks framework.
