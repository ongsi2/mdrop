---
title: MDVIEW sample
description: A short document demonstrating tables, tasks, footnotes, and code
tags:
  - markdown
  - local rendering
---

# Welcome

This sample gives you a quick look at how MDVIEW renders Markdown.

> Files you open are rendered in your browser and never uploaded to a server.

## Checklist

- [x] Headings and body text
- [x] Tables and alignment
- [x] Syntax-highlighted code
- [ ] Open your own `.md` file next

## Table

| Feature | What it does | Status |
| :--- | :--- | ---: |
| Contents | Tracks your place in long documents | Ready |
| Copy | Keeps headings, lists, and table alignment | Ready |
| Print | Applies a PDF-friendly layout | Ready |

## Code

```ts
const greeting = 'Hello';
console.log(`${greeting}, Markdown!`);
```

## Collapsible content

<details>
<summary>One more thing</summary>

When you save an open file in your editor, MDVIEW rerenders it without losing your place.

</details>

Footnotes are collected at the end of the document.[^local]

[^local]: The sample is a same-origin static file fetched and rendered in your browser.
