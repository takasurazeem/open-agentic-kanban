# Agentic Kanban

## Layout
- `server/` — Node, no framework. `api.mjs` (routes, used as Vite middleware in dev and by `index.mjs` in prod), `store.mjs` (in-memory index over the data dir, per-item persistence, fs watcher, change events), `gitsync.mjs` (auto-commit/pull/push of the data dir), `mcp.mjs` (stdio MCP server that calls the HTTP API), `model.mjs` (shared constants).
- `src/` — React + TypeScript UI. `App.tsx` (shell, hash routing `#/<project>/<board|table>?item=N&q=…`), `api.ts` (fetch + live `useBoard` hook over SSE), `query.ts` (filter syntax), `components/`.
- Styling is one stylesheet, `src/styles.css`, with tokens on `:root` and `[data-theme='dark']`. Use the `--c-<color>` tokens, not hex values, in components.

## Data
- Lives outside this repo, in `KANBAN_DATA_DIR` (default `~/Developer/kanban-data`, its own private git repo): `actors.json`, `<project>/project.json`, `<project>/items/<n>.md` (YAML front matter + body), `<project>/items/<n>.activity.jsonl` (append-only). Never commit board data here; `data/` is gitignored.
- `mutate(fn, event)` in `store.mjs` diffs the draft against the previous state and writes only changed files. Use `KANBAN_GIT_SYNC=0` and a scratch `KANBAN_DATA_DIR` when testing.
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
