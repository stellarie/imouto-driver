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
| `IMOUTO_STATE_HOME` | Base directory for per-project state. Default `~/.imouto/projects`. |
| `IMOUTO_MEMORY_DIR` | Global memory directory. Default `~/.imouto/memory`. |
| `IMOUTO_SKILLS_DIR` | Global skills directory. Default `~/.imouto/skills`. |
| `IMOUTO_GUIDE` | Global guidelines file. Default `~/.imouto/IMOUTO.md`. |
| `IMOUTO_EPISODE_TTL_DAYS` | Episode lifetime for `memory_consolidate`. Default 30. |
| `IMOUTO_SHELL` | Shell for `shell` and gates: `bash`, `sh`, `pwsh`, `powershell`, `cmd`, or a path. Default: chosen per platform. |

In the repo `.env`, `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` override the shell environment.
Other `.env` values only fill unset variables, so an MCP client's `IMOUTO_ROOT` still wins.

## Windows and Linux

The driver runs on both. CI tests every change on `ubuntu-latest` and `windows-latest`.
Each imouto's system prompt names its platform and shell, so it writes commands for the right shell.

| Topic | Windows | Linux |
|---|---|---|
| Shell | Git Bash, found through `git --exec-path`. Then `pwsh`, `powershell`, `cmd`. | `/bin/bash`, else `/bin/sh`. |
| Alternative shell | `IMOUTO_SHELL=pwsh` (or a path). | `IMOUTO_SHELL=<path>`. |
| Trap | `C:\Windows\System32\bash.exe` is the WSL launcher. It runs commands in a Linux distro, not in your repo. The driver always rejects it. | None known. |
| Without Git Bash | Imoutos get PowerShell or `cmd`. POSIX commands such as `sed`, `awk`, and `'…'` quoting fail; under `cmd`, `>` inside single quotes becomes a redirect. Install Git for Windows. | Not applicable. |
| Registering the MCP server | Point the command at `node.exe` and the `tsx` CLI. MCP clients often cannot start `.cmd` shims such as `corepack`. | `corepack pnpm --dir <imouto-driver> mcp` works. |
| Paths | Git Bash writes `C:\` as `/c/`. Tools accept `C:/...` and `C:\...`. | Paths are case-sensitive. |
| Line endings | `fs edit` and `fs write` keep a file's CRLF. Git's `core.autocrlf` owns the rest. Imoutos never convert line endings. | LF. |
| Command timeout | `taskkill /T /F` stops the whole process tree. | The command runs in its own process group; the group gets `SIGKILL`. |
| File locks | `search.db` opens per call. An editor can still hold a lock on a project file. | No mandatory locks. |
| WSL | To run the driver inside WSL, install Node there and keep the repo inside WSL. Do not mix Windows and WSL paths. | Not applicable. |

### Gates

`run_gates` reads `<root>/.imouto/gates.json` when it exists:

```json
{
  "gates": [
    { "name": "fmt", "command": "cargo fmt --all -- --check" },
    { "name": "test", "command": "cargo test --workspace --no-fail-fast", "timeoutSec": 1800 },
    { "name": "win-only", "command": { "windows": "cargo test -p chibipop-windows" } }
  ]
}
```

- A gate's `command` is a string, or an object with `windows`, `linux`, and `darwin` keys. A gate without a command for this platform reports `SKIP`.
- Gates run in file order through the selected shell. `timeoutSec` defaults to 900.
- Without `gates.json`, `run_gates` runs the `typecheck`, `lint`, `build`, and `test` scripts from `package.json`.

## Use from Claude Code

Register the server once at user scope:

```sh
claude mcp add -s user imouto-driver -- <node path> <imouto-driver>/node_modules/tsx/dist/cli.mjs <imouto-driver>/src/mcp.ts
```

Point the command at `node` directly. On Windows, MCP clients often cannot start `.cmd` shims such as `corepack`.
Call `set_root` when the orchestrator starts work on each project.
The project `.imouto/` directory now holds only `gates.json`. Commit it, or add `.imouto/` to `.git/info/exclude`.

Orchestrator tools:

| Tool | Purpose |
|---|---|
| `health` | Root, model, live or mock, limits |
| `set_root` | Point the driver at another project directory |
| `spawn` | Start an imouto. The result warns when its scope overlaps another untucked imouto. |
| `send` | Mail an imouto |
| `wait` | Receive mail for the orchestrator (max 120 s per call; use 110 or less from Claude Code) |
| `status` | Show orchestrator mail first, then each imouto's state, budget, mail, and activity. |
| `tuck` | Suspend an imouto; its state is kept |
| `wake` | Resume a tucked imouto, with optional text and extra budget. On a pending tuck, cancels the tuck |
| `run_gates` | Run the root's gates: `.imouto/gates.json`, else `package.json` scripts |
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

## Guidelines (IMOUTO.md)

Every imouto's system prompt includes two optional files, after the base rules:

1. The global guidelines: `~/.imouto/IMOUTO.md`, or `IMOUTO_GUIDE`.
2. The project guidelines: `<root>/IMOUTO.md`.

Keep them short: rules every task needs. Each file is cut at 12,000 characters.
Put long material in a skill, and name the skill in `IMOUTO.md`.
The orchestrator's brief carries only task-specific constraints.

Each activation names the project root, exact scope, relative scope, platform, and shell. The default final report uses five sections:

- Result
- Changed
- Checks
- Concerns
- Next

Each section permits five bullets. A stricter brief overrides this format.

## Memory

Memory grows slowly, in three layers:

1. **Episodes.** The driver records every finished activation. No LLM is involved.
2. **Candidates.** Imoutos call `memory_note` with evidence. Others add support with `supports`, or dispute a fact with `contests`.
3. **Facts.** Only the orchestrator promotes. A candidate needs evidence from 2 episodes, or 1 executed proof.

Imoutos see the fact index in their system prompt. Project facts live in the project state directory. Global facts use the global memory directory.
Edit a fact body at promotion when supporting evidence corrected the claim.

Search is SQLite FTS5 with BM25 ranking. There are no embeddings.

## Skills

A skill is a reusable procedure: `<name>/SKILL.md` with `name` and `description` frontmatter and a Markdown body.

- Imoutos see only the skill index in their system prompt. They load a body with `skill_read`.
- A long skill keeps extra `.md` pages next to its `SKILL.md`. `skill_read` lists them under `Files:`, and `skill_read` with `file` loads one page.
- Imoutos propose skills with `skill_draft`, with evidence of where the procedure worked. Only the orchestrator promotes.
- Project skills live in the project state directory. Global skills use the global skills directory. A project skill wins on a name clash.
- `memory_consolidate` suggests a skill when 3 or more `procedure` facts share a tag.

To add a skill by hand, create `<skills dir>/<name>/SKILL.md`:

```markdown
---
name: run-rust-tests
description: Run the workspace tests the way CI does
---

1. ...
```

## Budgets and context

Budgets are in cost units. One cost unit is one cache-miss prompt token.
A cache hit costs 0.02 units and an output token 4 units, following deepseek-flash prices.
1,000,000 units is about $0.15 off-peak. `status` shows the estimate in USD.
Resent history is mostly cache hits, so it costs little.

Before every model call, the driver:

1. delivers pending mail as a new message;
2. compacts the history into a summary when the estimated prompt passes 600,000 tokens (`compactAtTokens`);
3. sends one wrap-up message at 90% of the budget or of the turn limit (default 100 turns);
4. skips a call it cannot afford: the imouto tucks and mails a handoff with its last text, last tool calls, and `git diff --stat`.

`fs read` returns 400 numbered lines by default; `offset` and `limit` select a range. A tool result is cut to 16,000 characters in history.

## Watch the imoutos think

```sh
corepack pnpm watch                  # follow the project state directory live
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
| `guide-smoke` | Live run: a Rust task with no guideline hints; passes when the imouto reads `rust-guidelines` on its own |

## State

Runtime state lives under `IMOUTO_STATE_HOME`, or `~/.imouto/projects` by default.
Each project uses `<sanitized-final-segment>-<first-12-sha256-hex>` as its directory name.
The hash uses the normalized absolute project root.

On first load, the driver copies recognized legacy state from `<root>/.imouto/` when the new state directory does not exist.
It never copies `search.db` or `gates.json`. The old files stay in place unchanged.

Each project state directory contains:

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

- `shell` runs with `cwd` at the imouto's scope but is not jailed. Imoutos have used it to leave their scope.
- Scope overlap produces a warning. The driver does not block the spawn or lock files.
- Search scans Markdown below the project root. Avoid broad roots such as a user home directory.
- Child budgets are not refunded.
- The project state directory's `events.jsonl` grows without rotation.
- A fact or skill promoted mid-activation reaches an imouto at its next activation.

## Backlog

- Web search.
- Token-by-token reasoning in the live log.
- Railway deployment with an HTTP transport and key auth.
- Code navigation for large repos: a symbol-ranked repo map and code search. Gate it on a before-and-after benchmark.
