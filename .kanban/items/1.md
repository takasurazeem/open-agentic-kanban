---
number: 1
title: "First draft: GitHub-style board on localhost"
status: in_progress
rank: 1
priority: High
size: null
labels:
  - enhancement
assignees: []
agent:
  state: idle
createdAt: 2026-11-05T04:01:01.952Z
updatedAt: 2026-11-05T04:01:01.952Z
---

## Why

Prove the concept: projects, columns, cards, and rich markdown.

## Demo

This very card renders **markdown**, code, images, and diagrams:

```js
const board = await openBoard('localhost:5173');
board.render(['markdown', 'mermaid', 'images']);
```

```mermaid
flowchart LR
    P[Projects] --> B[Board]
    B --> C[Cards]
    C --> M[Markdown + Mermaid]
```

![board preview](https://picsum.photos/seed/kanban/640/320)

