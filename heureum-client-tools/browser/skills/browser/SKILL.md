---
name: browser-automation
description: Automate Chrome browser actions — navigate, click, type, screenshot, and extract content from web pages
tools: browser_navigate, browser_new_tab, browser_click, browser_type, browser_get_content, browser_screenshot, browser_hover, browser_select, browser_evaluate, browser_scroll, browser_key_press, browser_back, browser_forward, browser_reload, browser_get_tabs, browser_switch_tab, browser_close_tab, browser_wait_for
---

# Browser Automation Skill

You have access to 18 browser tools that control the user's Chrome browser through an extension. The user is already logged in to their websites.

## Workflow

1. **Observe first**: Always call `browser_get_content` to see the current page structure and available CSS selectors before interacting.
2. **Interact**: Use the selectors from `browser_get_content` to click, type, select, or hover on elements.
3. **Re-observe after changes**: After clicks or navigation, call `browser_get_content` again to get updated selectors.
4. **Handle dynamic content**: Use `browser_wait_for` after actions that trigger AJAX or SPA transitions.
5. **Capture visual state**: Use `browser_screenshot` when you need to verify layout or visual changes.

## Tool Categories

### Navigation
- `browser_navigate` — Go to a URL in the current tab
- `browser_new_tab` — Open URL in a new tab (preserves current tab)
- `browser_back` / `browser_forward` — Browser history navigation
- `browser_reload` — Refresh the current page

### Interaction
- `browser_click` — Click an element by CSS selector
- `browser_type` — Type text into an input field
- `browser_select` — Select a dropdown option
- `browser_hover` — Hover over an element (triggers tooltips/dropdowns)
- `browser_key_press` — Send keyboard events (Enter, Escape, Tab, etc.)
- `browser_scroll` — Scroll the page or a specific element

### Observation
- `browser_get_content` — Get page title, URL, interactive elements, and visible text
- `browser_screenshot` — Capture page or element as PNG image
- `browser_evaluate` — Execute JavaScript and return results

### Tab Management
- `browser_get_tabs` — List all open tabs
- `browser_switch_tab` — Switch to a different tab
- `browser_close_tab` — Close a tab

### Synchronization
- `browser_wait_for` — Wait for an element to appear/disappear/become visible

## Best Practices

- **CSS selectors change** after page updates. Always re-fetch with `browser_get_content`.
- **Prefer `browser_new_tab`** over `browser_navigate` to avoid losing the user's current page.
- **Use `browser_evaluate` sparingly** — prefer standard tools when possible.
- **For forms**: get content → type into fields → click submit → wait for response.
- **For SPAs**: after clicking, use `browser_wait_for` before extracting content.
