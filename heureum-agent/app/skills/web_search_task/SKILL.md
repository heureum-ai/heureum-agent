---
name: web_search_task
description: Web search and content retrieval workflow
server_tools: mcp_web__search, mcp_web__fetch, mcp_filesystem__read
client_tools:
depends_on:
---
You have `mcp_web__search`, `mcp_web__fetch` and `mcp_filesystem__read` tools for web research.

## Workflow — always follow this sequence:

1. `mcp_web__search(query="...")` — returns snippets and URLs.
   Search snippets are summaries, not full content. Never answer based on snippets alone.

2. `mcp_web__fetch(url="...")` — fetches the page and saves full content to a session_file.
   Call fetch on the top 1–2 URLs from search results.

3. `mcp_filesystem__read(path="<session_file>")` — read the saved content.
   The fetch result includes a session_file path. Use read to access the actual content.

## Tool reference

`mcp_web__search(query, max_results?, search_depth?, country?)`
  Search the web and return snippets with URLs.
  - `query`: search query string (required)
  - `max_results`: number of results, 1–20 (default: 1). Increase for broad research.
  - `search_depth`: `"basic"` (default) or `"advanced"` for deeper search.
  - `country`: ISO code (e.g. `"KR"`) or country name for geo-relevant results.

`mcp_web__fetch(url, max_length?, start_index?, extract_mode?)`
  Fetch a URL and save full content to a session_file. Returns a short snippet inline.
  - `url`: the URL to fetch (required)
  - `max_length`: max characters to extract (default: 5000).
  - `start_index`: character offset to start reading from (default: 0). Use for pagination on long pages.
  - `extract_mode`: `"markdown"` (default) or `"text"`.

`mcp_filesystem__read(path, offset?, limit?)`
  Read the saved session_file content.
  - `path`: file path (required)
  - `offset`: start line, 1-indexed.
  - `limit`: max lines to read.

## Key rules
- After search, you must call `mcp_web__fetch` before answering. Search snippets are not sufficient.
- After fetch, you must call `mcp_filesystem__read` on the session_file. Fetch saves content to a file and does not return it inline.
- For broad topics, run 2–3 `mcp_web__search` calls in parallel with diverse keywords.
- Call multiple `mcp_web__fetch` in parallel on different URLs in a single turn.
- After fetches complete, call multiple `mcp_filesystem__read` in parallel in a single turn.
