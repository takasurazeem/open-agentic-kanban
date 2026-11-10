# Agentic Kanban

## Layout
- `server/` — Node, no framework. `api.mjs` (routes, used as Vite middleware in dev and by `index.mjs` in prod), `store.mjs` (in-memory index over the data dir, per-item persistence, fs watcher, change events), `gitsync.mjs` (auto-commit/pull/push of the data dir), `mcp.mjs` (stdio MCP server that calls the HTTP API), `model.mjs` (shared constants).
- `src/` — React + TypeScript UI. `App.tsx` (shell, hash routing `#/<project>/<board|table>?item=N&q=…`), `api.ts` (fetch + live `useBoard` hook over SSE), `query.ts` (filter syntax), `components/`.
- Styling is one stylesheet, `src/styles.css`, with tokens on `:root` and `[data-theme='dark']`. Use the `--c-<color>` tokens, not hex values, in components.

## Data
- There is no central board store. Each project's cards live in its own code repo, in `<repo>/.kanban/` (`project.json`, and one folder per card, `items/<n>/`, holding `item.md` with YAML front matter + body, `activity.jsonl` append-only, and `attachments/`). `.kanban/` is tracked by the code repo, so the board ships with the project (commit cards with code). Optionally it can be its own nested git repo (has a `.git`, excluded from the code repo), which `gitsync.mjs` then auto-commits and syncs. `data/` is gitignored.
- Machine-local state lives in `KANBAN_CONFIG_DIR` (default `~/.config/agentic-kanban`): `actors.json` and `.registry.json` (project id → repo path). `store.mjs` `attachRepo` points a repo at the board; `gitsync.create(dir)` is one sync per nested `.kanban/` repo.
- `mutate(fn, event)` in `store.mjs` diffs the draft against the previous state and writes only changed files. Use `KANBAN_GIT_SYNC=0` and a scratch `KANBAN_CONFIG_DIR` plus a scratch git repo when testing.
- `scripts/install-launchd.sh` runs the production server at login.

## Checks
- `npm run typecheck` and `npm run build` must pass.
- Verify UI changes in the browser at http://localhost:5173 (the dev server also serves the API).

## Working the board as an agent
When the `kanban` MCP server is connected:
1. `next_item` (or the item the user named) → `claim_item` with a one-line plan.
2. `report_progress` with short notes as you go; attach `branch` / `prUrl` when you have them.
3. If you need a decision, `report_progress` with `state: "blocked"` and the question in `note`, then stop.
4. When finished, `report_progress` with `state: "needs_review"` and a summary of what changed and how it was verified. Don't mark items Done yourself; the human approves.
