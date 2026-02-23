---
name: web_search_task
description: Web search and content retrieval workflow
server_tools: mcp_web__search
client_tools: web_fetch, read
depends_on:
---
You have `mcp_web__search`, `web_fetch` and `read` tools for web research.

## Workflow — always follow this sequence:

1. `mcp_web__search(query="...")` — returns snippets and URLs.
   Search snippets are summaries, not full content. Never answer based on snippets alone.

2. `web_fetch(url="...")` — fetches the page and saves content as a local .md file.
   Call fetch on the top 1–2 URLs from search results.

3. `read(path="<md_path>")` — read the saved .md file.
   The fetch result includes a file path. Use read to access the actual content.

## Tool reference

`mcp_web__search(query, max_results?, search_depth?, country?)`
  Search the web and return snippets with URLs.
  - `query`: search query string (required)
  - `max_results`: number of results, 1–20 (default: 1). Increase for broad research.
  - `search_depth`: `"basic"` (default) or `"advanced"` for deeper search.
  - `country`: ISO code (e.g. `"KR"`) or country name for geo-relevant results.

`web_fetch(url, max_length?, start_index?, extract_mode?)`
  Fetch a URL and save content as a local .md file. Returns a short snippet inline.
  - `url`: the URL to fetch (required)
  - `max_length`: max characters to extract (default: 20000).
  - `start_index`: character offset to start reading from (default: 0). Use for pagination on long pages.
  - `extract_mode`: `"markdown"` (default) or `"text"`.

`read(path)`
  Read a local file.
  - `path`: path to the .md file saved by web_fetch.

## Key rules
- After search, you must call `web_fetch` before answering. Search snippets are not sufficient.
- After fetch, use `read(path="<md_path>")` to read the saved .md file for full content.
- For broad topics, run 2–3 `mcp_web__search` calls in parallel with diverse keywords.
- Call multiple `web_fetch` in parallel on different URLs in a single turn.
- After fetches complete, call multiple `read` in parallel in a single turn.
