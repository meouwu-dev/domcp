# DOMCP

DOMCP is a DOM-first MCP server for browsing and scraping websites. It tries cheap HTTP plus Readability extraction first, escalates to Playwright/Chromium only when JavaScript rendering is needed, and exposes screenshots only as a last-resort vision fallback.

## Install

```bash
npm install
npx playwright install chromium
```

## Run

Development:

```bash
npm run dev
```

Build and run:

```bash
npm run build
npm start
```

## MCP Client Config

Using the TypeScript entrypoint:

```json
{
  "mcpServers": {
    "domcp": {
      "command": "npx",
      "args": ["tsx", "<absolute-path-to-domcp>/src/server.ts"]
    }
  }
}
```

Using the compiled entrypoint:

```json
{
  "mcpServers": {
    "domcp": {
      "command": "node",
      "args": ["<absolute-path-to-domcp>/dist/server.js"]
    }
  }
}
```

Claude Code project-scoped example with a persistent login profile:

```json
{
  "mcpServers": {
    "domcp": {
      "type": "stdio",
      "command": "node.exe",
      "args": ["<absolute-path-to-domcp>/dist/server.js"],
      "env": {
        "DOMCP_USER_DATA_DIR": "<absolute-path-to-browser-profile>",
        "DOMCP_HEADLESS": "false"
      }
    }
  }
}
```

Or add it from PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path <absolute-path-to-browser-profile>

claude mcp add --transport stdio --scope project `
  --env DOMCP_USER_DATA_DIR=<absolute-path-to-browser-profile> `
  --env DOMCP_HEADLESS=false `
  domcp -- node.exe <absolute-path-to-domcp>/dist/server.js
```

Claude Code project-scoped setup using the TypeScript source entrypoint:

```bash
claude mcp add-json --scope project domcp '{
  "type": "stdio",
  "command": "node.exe",
  "args": [
    "../domcp/node_modules/tsx/dist/cli.mjs",
    "../domcp/src/server.ts"
  ],
  "env": {
    "DOMCP_USER_DATA_DIR": "./.domcp-profile",
    "DOMCP_HEADLESS": "false"
  }
}'
```

## Tools

DOMCP also sends server-level MCP instructions to clients: use `navigate` and `get_current_state` first, interact with numbered targets via `click` or `type_text`, use `click_text` for visible DOM text that is not exposed as a numbered target, and call `screenshot` only as a last fallback after explaining why DOM output was insufficient.

For a full agent workflow and skill-writing template, see `AI_AGENT_GUIDE.md`. In Claude Code, load the same guide with:

```text
/mcp__domcp__agent_guide
```

- `extract_content(url)`: Fetches a page first, extracts the main readable content with Readability, converts it to Markdown with Turndown, and only renders with Chromium if the result is too thin. When `DOMCP_USER_DATA_DIR` is configured, this uses Chromium first by default so authenticated cookies from the persistent profile are available.
- `navigate(url)`: Loads a URL in the persistent browser context and returns `{ contentMarkdown, elements }`.
- `click(elementId)`: Clicks a numbered link, button, input, textarea, or ARIA link/button from the current page and returns the new state.
- `click_text(text, exact?, occurrence?)`: Fallback DOM action that clicks visible text on the current page when the target appears in `contentMarkdown` but is not exposed as a numbered element. Useful for custom cards, rows, and non-semantic clickable containers.
- `type_text(elementId, text)`: Fills a numbered input or textarea.
- `get_current_state()`: Re-reports the current browser page without navigating.
- `screenshot()`: Last-fallback screenshot tool for canvas, WebGL, visually ambiguous pages, or broken DOM extraction. The client should explain why DOM output was insufficient before calling it.
- `close()`: Closes the persistent browser context.

## Example Loop

1. Call `navigate` with a URL.
2. Read `contentMarkdown` for the cleaned page content.
3. Inspect `elements`, choose a numbered target, then call `click` with that `elementId`.
4. Repeat `click` or call `type_text` for forms.
5. If desired visible text is present but missing from `elements`, try `click_text`.
6. Use `screenshot` only if the DOM output is not enough to understand or operate the page.

Example response shape:

```json
{
  "url": "https://example.com/",
  "contentMarkdown": "# Example Domain\n\nThis domain is for use in illustrative examples...",
  "elements": [
    {
      "id": 0,
      "role": "link",
      "text": "More information...",
      "href": "https://www.iana.org/domains/example"
    }
  ]
}
```

## Logged-In Sites

For websites that require login, configure a persistent Playwright profile and run Chromium visibly:

```json
"env": {
  "DOMCP_USER_DATA_DIR": "<absolute-path-to-browser-profile>",
  "DOMCP_HEADLESS": "false"
}
```

Then:

1. Start Claude Code from the project that has this MCP config.
2. Ask Claude to use `domcp` to navigate to the site's login page.
3. Complete the login yourself in the Chromium window that opens.
4. Ask Claude to continue browsing the logged-in area.

The cookies are stored in `DOMCP_USER_DATA_DIR`, so future MCP sessions can reuse the login as long as the site session remains valid. This is separate from your normal Chrome or Edge profile.

## Configuration

Environment variables:

- `DOMCP_USER_AGENT`: Override the default realistic browser user agent.
- `DOMCP_USER_DATA_DIR`: Optional Playwright profile directory for persistent cookies and login sessions.
- `DOMCP_HEADLESS`: Set to `false` to show the Playwright Chromium window for manual login. Defaults to `true`.
- `DOMCP_BROWSER_FIRST_WITH_PROFILE`: Defaults to `true` when `DOMCP_USER_DATA_DIR` is set. Set to `false` to force HTTP-first extraction even with a profile.
- `DOMCP_REQUEST_DELAY_MS`: Per-domain request delay. Defaults to `1000`.
- `DOMCP_FETCH_TIMEOUT_MS`: Fetch timeout. Defaults to `15000`.
- `DOMCP_NAVIGATION_TIMEOUT_MS`: Playwright navigation/action timeout. Defaults to `30000`.
- `DOMCP_PAGE_READY_UNTIL`: Playwright page readiness state for navigation and short post-action waits. Defaults to `domcontentloaded`. Accepted values: `commit`, `domcontentloaded`, `load`, `networkidle`.
- `DOMCP_RENDER_SETTLE_MS`: Extra settle time after navigation before extracting DOM content. Defaults to `750`.
- `DOMCP_ACTION_SETTLE_MS`: Short settle time after click-like actions before extracting the next state. Defaults to `500`.
- `DOMCP_THIN_CONTENT_CHARS`: Markdown length threshold before escalating from fetch to browser rendering. Defaults to `200`.
- `DOMCP_MAX_ELEMENTS`: Maximum clickable/form elements returned per page. Defaults to `80`.

DOMCP checks `robots.txt` before fetch and navigation requests and applies the greater of the configured delay and the site's `Crawl-delay` directive when present.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
