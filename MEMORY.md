---
schema: codex-project-memory/v1
project: imouto-driver
last_verified: 2026-09-19
---

# Project Memory

## Purpose

This project provides an MCP server that orchestrates DeepSeek imoutos for one project root at a time.

## Commands

- `corepack pnpm typecheck` - Type-check all TypeScript without emitting files. [verified: 2026-09-19] [source: package.json]
- `corepack pnpm test` - Run the offline Vitest suite. [verified: 2026-09-19] [source: package.json]

## Architecture

- Runtime state uses a derived project directory under the configured state home. [status: active] [verified: 2026-09-19] [source: src/runtime/state-dir.ts]
- Gate configuration remains at `<root>/.imouto/gates.json`. [status: active] [verified: 2026-09-19] [source: src/gates/runner.ts]

## Conventions

- Tests inject state homes below temporary roots to avoid user-state writes. [verified: 2026-09-19] [source: src/runtime/driver.test.ts]

## Known Pitfalls

- Existing state directories suppress legacy copying -> remove only test fixtures when testing migration. [status: active] [verified: 2026-09-19] [source: src/runtime/state-dir.ts]

## Decisions

### 2026-09-19 - Store runtime state outside projects

- Decision: Derive each state directory from the normalized project root and a SHA-256 suffix.
- Why: One user-scoped server must serve projects without writing runtime state into them.
- Alternatives: Project-local runtime state required per-project exclusions and registrations.
- Evidence: `src/runtime/state-dir.test.ts` and `src/runtime/driver.test.ts`.

## Open Questions

- [ ] Confirm hosted CI on Windows and Linux. Next check: inspect the pull request checks. [added: 2026-09-19]

## Session Handoffs

### 2026-09-19 - Move runtime state outside projects

- Done: Implemented state derivation, legacy migration, tests, scripts, documentation, and health reporting.
- Pending: Hosted CI and pull request review.
- Next: Inspect both hosted CI jobs after opening the pull request.
- Verification: `corepack pnpm typecheck` and `corepack pnpm test` passed locally.
