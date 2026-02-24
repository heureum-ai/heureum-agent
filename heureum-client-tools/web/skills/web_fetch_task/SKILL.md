---
name: web_fetch_task
description: Web Fetch — fetch web pages after search and extract readable content
tools: web_fetch
---

# Web Fetch

Fetch web pages and extract readable content.

## Workflow: Web Search → Web Fetch → Read

1. **Web Search** returns snippets and URLs. Web Search may be provided by another skill — check your available tools.
   Search snippets are summaries, not full content. Never answer from snippets alone.

2. `web_fetch(url="...")` — fetches the page, saves content as a local .md file.
   Call on the top 1–2 URLs from search results.

3. `read(path="<md_path>")` — read the saved .md file for full content.
   The fetch result includes a file path. You must call read after fetch.

## Tool reference

`web_fetch(url, max_length?, start_index?, extract_mode?, headers?)`
  Fetch a URL and extract readable content.
  - `url`: URL to fetch (required, must include http:// or https://)
  - `max_length`: max characters to extract (default: 5000)
  - `start_index`: character offset for pagination (default: 0)
  - `extract_mode`: `"markdown"` (default) or `"text"`
  - `headers`: optional HTTP headers

## Key rules
- After Web Search, always call web_fetch. Search snippets are not sufficient.
- After fetch, you must use `read(path="<md_path>")` to read the saved .md file for full content.
- Call multiple web_fetch in parallel on different URLs.
- If content is truncated, call again with updated start_index.
