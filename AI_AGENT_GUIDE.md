# DOMCP AI Agent Guide

This guide is written for AI agents and skill authors that want to use DOMCP effectively.

DOMCP is a DOM-first browsing MCP. Treat the structured DOM output as the main interface, and treat screenshots as a last fallback.

## Core Principle

Use this order:

1. Use DOM tools first: `navigate`, `get_current_state`, `click`, and `type_text`.
2. Read `contentMarkdown` for page meaning.
3. Read `elements` for numbered interaction targets.
4. Act on numbered targets with `click` or `type_text`.
5. Use `screenshot` only when DOM output is insufficient, and explain why before using it.
6. Ask the user to interact manually only when the action requires human control, credentials, CAPTCHA, payment confirmation, 2FA, or a browser state the agent cannot reach safely.

## Tool Roles

- `extract_content(url)`: Fast content extraction for pages where you only need readable text. It does not maintain a browser interaction loop.
- `navigate(url)`: Open a page in the persistent Chromium context and return both readable content and numbered action targets. Use this for most browsing tasks.
- `get_current_state()`: Re-read the current page after waiting, user interaction, or a suspected page update.
- `click(elementId)`: Click a numbered target from the latest `navigate` or `get_current_state` result.
- `type_text(elementId, text)`: Fill a numbered input or textarea.
- `screenshot()`: Last fallback when DOM output cannot answer what is visible or what to do next.
- `close()`: Close the browser context when the task is finished or stale.

## Standard Browsing Flow

1. Start with `navigate(url)` when the user asks to browse, choose, order, search, or interact with a site.
2. Inspect the returned `url`, `contentMarkdown`, and `elements`.
3. Use `contentMarkdown` to understand page state, available options, errors, confirmations, and instructions.
4. Use `elements` to find the best action target by `id`, `role`, `text`, and `href`.
5. Call `click(elementId)` for navigation, selection, buttons, tabs, menu items, and clickable rows.
6. Call `type_text(elementId, text)` for search boxes, address fields, forms, and other text inputs.
7. After each action, inspect the returned state before deciding the next action.
8. If the page updates asynchronously and the returned state looks stale, call `get_current_state()`.
9. Repeat until the user goal is complete or a human decision/action is required.

## Headless And Visible Browser Use

DOMCP can run Chromium headless or visibly:

- `DOMCP_HEADLESS=true`: Good for normal scraping, reading, and fully automatable flows.
- `DOMCP_HEADLESS=false`: Good for login, 2FA, CAPTCHA, payment, checkout review, geolocation permission, or anything the user must see or control.
- `DOMCP_USER_DATA_DIR`: Stores cookies and browser profile data so future sessions can reuse login state.

When a visible browser is available and the task needs user action:

1. Tell the user exactly what you need them to do in the browser window.
2. Pause your automation steps.
3. After the user says they are done, call `get_current_state()`.
4. Continue from the updated DOM state.

Good user handoff examples:

- "Please complete the login in the browser window. After you reach the account page, tell me done."
- "This checkout confirmation needs your review. Please confirm or cancel in the visible browser, then tell me what happened."
- "The site is showing CAPTCHA/2FA, so I need you to complete that manually. I will continue after you say done."

## Screenshot Policy

Do not use `screenshot` as the default browsing method.

Use `screenshot` only when one of these is true:

- `navigate` or `get_current_state` fails because DOM extraction is broken.
- The page is canvas, WebGL, image-heavy, map-based, or otherwise not represented meaningfully in HTML text.
- The DOM content is present but visually ambiguous, such as unlabeled icon-only controls or layout-sensitive choices.
- You need to verify visual state that cannot be inferred from `contentMarkdown` or `elements`.

Before calling `screenshot`, state the reason in plain language:

- "The DOM output has no labeled action targets for the visible controls, so I need a screenshot to identify them."
- "The page appears to render the product grid visually but not in readable DOM text, so I need a screenshot as fallback."
- "The current state is canvas-based and `elements` is empty, so DOM navigation cannot identify the next action."

After using `screenshot`, return to DOM tools whenever possible. If the screenshot reveals a labeled target that is also in `elements`, use `click` with the numbered element instead of relying on vision.

## Choosing Between Content And Actions

Use `contentMarkdown` when deciding:

- What page you are on.
- Whether a login, error, confirmation, or result is present.
- Which item, store, product, or option best matches the user request.
- Whether an action succeeded.

Use `elements` when deciding:

- What can be clicked or filled.
- Which numbered ID to pass to `click` or `type_text`.
- Whether a link can be navigated by `href`.
- Whether a desired target is missing from DOMCP's clickable target list.

If the content mentions an option but no matching element exists, try:

1. Call `get_current_state()` once in case the page changed.
2. Look for nearby text, shorter labels, icons, tabs, or parent-row text in `elements`.
3. If still missing and the page is visible, explain the limitation and ask the user to click it manually.
4. If visual inspection could solve it and manual action is not required, explain why and use `screenshot`.

## Handling Common Sites

Many modern sites use JavaScript and custom components. DOMCP detects native controls plus common clickable patterns such as links, buttons, ARIA button/link/menu roles, focusable elements, click handlers, and Angular Material ripple/list items.

If a site has poorly labeled controls:

- Prefer visible text from `elements`.
- Use stable labels, product names, store names, addresses, or prices to identify targets.
- Avoid guessing based only on element order unless the page state makes it obvious.
- If multiple targets look similar, ask a concise clarification or use more page context.

## Forms

For forms:

1. Use `navigate` or `get_current_state`.
2. Identify inputs in `elements` by placeholder, label text, or nearby context.
3. Use `type_text` for each text field.
4. Re-read state if the form performs validation or enables buttons dynamically.
5. Use `click` for submit/search/continue.
6. Verify the result in the returned state.

Never enter sensitive information unless the user explicitly provided it for this task. For passwords, 2FA, payment details, or identity verification, ask the user to type them in the visible browser.

## Login And Authentication

If a site requires login:

1. Navigate to the login page.
2. If credentials or 2FA are needed, ask the user to complete login in the visible browser.
3. After the user says done, call `get_current_state()`.
4. Continue using DOM tools.

If `DOMCP_USER_DATA_DIR` is configured, login cookies can persist across sessions. Do not assume the session is valid; verify with `get_current_state()` or by checking the page content after navigation.

## When To Ask The User

Ask the user to act when:

- The task requires credentials, 2FA, CAPTCHA, payment, legal consent, or identity confirmation.
- A visible browser prompt requires a human choice, such as location permission.
- The target action is not exposed in DOMCP and cannot be safely identified by DOM or screenshot.
- Multiple options match and the wrong choice would matter.
- The website blocks automation or presents an anti-bot flow.

Keep the request specific. Tell the user what to click/type and what to say when finished.

## Recovery Patterns

If a click seems to do nothing:

1. Call `get_current_state()`.
2. Check whether the URL, content, or elements changed.
3. If nothing changed, the site may need a more specific target, a wait, or manual action.

If the page looks like a login page unexpectedly:

1. Explain that the session may be expired.
2. Ask the user to log in in the visible browser if needed.
3. Call `get_current_state()` afterward.

If `elements` is empty but `contentMarkdown` has useful text:

1. Continue reading if the task is informational.
2. Use direct URLs if available in `href` text or page content.
3. Use `screenshot` only if interaction depends on visual controls.

If DOM extraction fails:

1. Explain that DOM extraction failed.
2. Use `screenshot` as fallback.
3. If possible, ask the user to perform the blocked action manually in the visible browser.

## Skill Prompt Template

Agents can adapt this into a skill:

```text
Use DOMCP as a DOM-first browser. For interactive browsing, start with navigate(url), then inspect contentMarkdown and elements. Use contentMarkdown to understand page state and use numbered elements for click(elementId) and type_text(elementId, text). After every action, inspect the returned state before continuing. Use get_current_state() after user interaction, asynchronous page updates, or when the page may have changed.

Do not use screenshot by default. Screenshot is a last fallback only when DOM content/action targets are insufficient, such as canvas/WebGL, visually ambiguous controls, image-only pages, or broken DOM extraction. Before calling screenshot, explain why DOM output is insufficient. After screenshot, return to DOM tools whenever possible.

For login, CAPTCHA, 2FA, payment, identity checks, permissions, or sensitive input, ask the user to interact in the visible browser. Tell the user exactly what to do, wait for them to say done, then call get_current_state() and continue.

Avoid guessing high-impact choices. If multiple matching targets exist or the correct action is ambiguous, ask a concise clarification.
```

## Minimal Decision Loop

```text
Need only readable content?
  Use extract_content(url), unless logged-in browser state is needed.

Need to browse or interact?
  Use navigate(url).

Need to choose next step?
  Read contentMarkdown and elements.

Target is numbered?
  Use click(elementId) or type_text(elementId, text).

Page may have changed?
  Use get_current_state().

DOM is insufficient?
  Explain why, then use screenshot as last fallback.

Human-only step?
  Ask user to act in visible browser, then call get_current_state().
```
