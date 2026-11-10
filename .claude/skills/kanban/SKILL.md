---
name: kanban
description: Work this project's kanban board. The board lives in .kanban/ in this repo (one folder per card) and is served by the Agentic Kanban app. Use when the user mentions the board, cards, the queue, "next item", a card number, or asks you to pick up, plan, split up, report on or review work; also when starting a task that should be tracked as a card.
---

# Kanban board

This repo's cards live in `.kanban/`, tracked by git like code, so the board ships with the project.

## Where things are

```
.kanban/project.json              columns (statuses) and linked repos
.kanban/items/<n>/item.md         the card: YAML front matter (title, status, rank, priority, size,
                                  labels, assignees, agent) + markdown body
.kanban/items/<n>/activity.jsonl  its timeline, append-only
.kanban/items/<n>/attachments/    its files
```

Columns: Backlog, Todo, In progress, On hold, In review, Done. Cards also carry an agent state:
`idle`, `queued`, `running`, `blocked`, `needs_review`, `done`.

## Working a card (when the `kanban` MCP server is connected)

1. Find this repo's project with `find_project`, passing the repo's absolute folder path. If none matches,
   ask the user before creating one with `create_project` (pass `path`).
2. `next_item`, or the card the user named, then `claim_item` with a one-line plan. Claiming moves a
   Backlog or Todo card to In progress.
3. `report_progress` with short notes as you go. Attach `branch` and `prUrl` when you have them.
4. If you need a decision, `report_progress` with `state: "blocked"` and the question in `note`, then stop.
5. When finished, `report_progress` with `state: "needs_review"` and a summary of what changed and how you
   verified it. That moves the card to In review. Never mark a card Done yourself; the human approves.

Other tools: `list_items`, `get_item`, `comment`, `update_item`, `create_item` (split out follow-ups), `link_repo`.
On hold is for the human: do not move cards there yourself.

## Without the MCP server

You can read and edit the files directly; the app picks changes up live. Edit `item.md` (keep the front matter
valid YAML), never rewrite `activity.jsonl`, only append one JSON object per line. A new card is a new folder
`items/<next number>/` with an `item.md`. To attach a file, put it in `items/<n>/attachments/`.

## Rules

- Commit card changes together with the code they belong to.
- The repo may be public, so never put secrets, tokens or private data in a card or attachment.
- Keep cards small and concrete: a title that states the outcome, a body with acceptance criteria.
