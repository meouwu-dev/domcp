# DOMCP AI Agent Guide

This guide is written for AI agents and skill authors that want to use DOMCP effectively.

DOMCP is a DOM-first browsing MCP. Treat the structured DOM output as the main interface, and treat screenshots as a last fallback.

## Core Principle

Use this order:

1. Use DOM tools first: `navigate`, `get_current_state`, `click`, and `type_text`.
2. Read `contentMarkdown` for page meaning.
3. Read `elements` for discovery context (role, text, href) to help you build selectors.
4. Act with `click` (a Playwright selector you choose) or `type_text`.
5. Use `screenshot` only when DOM output is insufficient, and explain why before using it.
6. Ask the user to interact manually only when the action requires human control, credentials, CAPTCHA, payment confirmation, 2FA, or a browser state the agent cannot reach safely.

## Tool Roles

- `extract_content(url)`: Fast content extraction for pages where you only need readable text. It does not maintain a browser interaction loop.
- `navigate(url)`: Open a page in the persistent Chromium context and return both readable content and action targets (each with a ready-to-use `selector`). Use this for most browsing tasks.
- `get_current_state()`: Re-read the current page after waiting, user interaction, or a suspected page update.
- `click({ selector, ... })`: Click anything on the current page. Prefer the `selector` each element already provides (a `[data-domcp-id="N"]` handle DOMCP injects): it is a fast, unique CSS match. If a self-re-rendering page strips the handle between snapshots, call `get_current_state()` to re-stamp, then use the fresh `selector`. You may also pass any Playwright selector of your own (CSS, `text=`, `role=`, label, placeholder, xpath). Optional `nth`, `button`, `clickCount`, `modifiers`, `position`, and `force` mirror Playwright click options. Use `point: { x, y }` for a raw coordinate click as a last resort. Avoid hand-writing `role=...[name=...]` selectors on lazy-ARIA sites (e.g. Angular Material) — they can hang on the accessibility-tree walk; the injected handle and `text=` are safe.
- `type_text({ selector | elementId, text })`: Fill an input or textarea by selector (flexible) or by a numbered `elementId`.
- `screenshot()`: Last fallback when DOM output cannot answer what is visible or what to do next.
- `close()`: Close the browser context when the task is finished or stale.

## Standard Browsing Flow

1. Start with `navigate(url)` when the user asks to browse, choose, order, search, or interact with a site.
2. Inspect the returned `url`, `contentMarkdown`, and `elements`.
3. Use `contentMarkdown` to understand page state, available options, errors, confirmations, and instructions.
4. Use `elements` to find the target; each one carries a ready `selector` (its `[data-domcp-id="N"]` handle) plus `text`, `role`, and `href` to identify it.
5. Call `click({ selector })` with that handle for navigation, selection, buttons, tabs, menu items, and clickable rows — e.g. `{ selector: "[data-domcp-id=\"7\"]" }`. You can also pass your own selector such as `{ selector: "text=Add to cart" }`.
6. Call `type_text({ selector, text })` for search boxes, address fields, forms, and other text inputs.
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

After using `screenshot`, return to DOM tools whenever possible. If the screenshot reveals a labeled target, click it with a `text=` or `role=` selector instead of relying on vision. Use `point: { x, y }` only when no selector can reach it.

## Choosing Between Content And Actions

Use `contentMarkdown` when deciding:

- What page you are on.
- Whether a login, error, confirmation, or result is present.
- Which item, store, product, or option best matches the user request.
- Whether an action succeeded.

Use `elements` when deciding what to act on. Each element provides:

- `selector`: its `[data-domcp-id="N"]` handle — the target for `click`/`type_text`. Always prefer this.
- `role`, `text`, `href`: human context to pick the right element.
- `obscured: true` (only when set): the element is currently covered by something painted over it (commonly a modal backdrop, cookie banner, or sticky bar). Clicking it will fail/time out — do not target it until whatever covers it is dismissed.
- `offscreen: true` (only when set): the element is outside the viewport and must be scrolled into view before it can be clicked.

The page state also includes `activeDialog: { title }` when a modal is capturing interaction. When present, act on controls **inside** the dialog first (the obscured background elements are inert); finish or dismiss the dialog before targeting anything flagged `obscured`.

`elements` is a hint, not a limit. You can target anything in the DOM with a `click` selector even if it is not listed.

If the content mentions an option but you cannot find a clean target, try:

1. Call `get_current_state()` once in case the page changed (this also re-stamps fresh `data-domcp-id` handles).
2. Use the element's `selector`; if it no longer matches after a dynamic page update, call `get_current_state()` again to re-stamp, then use the fresh handle.
3. As a manual alternative, build a `text=` selector from the most specific visible label, such as a store name or product title — e.g. `{ selector: "text=Whole Foods Market" }`. Pass `nth` to disambiguate multiple matches.
4. If the page is visible and the target still cannot be reached safely, explain the limitation and ask the user to click it manually.
5. If visual inspection could solve it and manual action is not required, explain why and use `screenshot`.

## Handling Common Sites

Many modern sites use JavaScript and custom components. DOMCP detects native controls plus common clickable patterns such as links, buttons, ARIA button/link/menu roles, focusable elements, click handlers, and Angular Material ripple/list items.

If a site has poorly labeled controls:

- Prefer the element's provided `selector` (its `[data-domcp-id]` handle); it works even when a control is unlabeled or icon-only.
- Use the `text`, `role`, and `href` fields, plus stable labels, product names, store names, addresses, or prices, to identify which element you want.
- Avoid guessing based only on element order unless the page state makes it obvious.
- If multiple targets look similar, ask a concise clarification or use more page context.

## Forms

For forms:

1. Use `navigate` or `get_current_state`.
2. Identify inputs by placeholder, label text, or nearby context (use `elements` for hints).
3. Use `type_text({ selector, text })` for each text field, e.g. `{ selector: "role=textbox[name='Email']" }`.
4. Re-read state if the form performs validation or enables buttons dynamically.
5. Use `click({ selector })` for submit/search/continue.
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

If a click times out or seems to do nothing:

1. Call `get_current_state()`.
2. Check whether the URL, content, or elements changed.
3. Check `activeDialog` and the target's `obscured`/`offscreen` flags. If the target is `obscured`, a modal or overlay is on top — handle the dialog (or dismiss the banner) first. If `offscreen`, scroll it into view before clicking.
4. If nothing changed and nothing is covering the target, the site may need a more specific target, a wait, or manual action.

If a target you want is flagged `obscured` and `activeDialog` is set:

1. Read the dialog's controls (the elements that are not obscured) and complete or dismiss it — e.g. submit the form, or click its close/cancel control.
2. Call `get_current_state()` to confirm the dialog closed and re-stamp handles.
3. Then act on the previously obscured target.

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
Use DOMCP as a DOM-first browser. For interactive browsing, start with navigate(url), then inspect contentMarkdown and elements. Use contentMarkdown to understand page state and use elements as discovery context. There is one click tool: click({ selector }) where selector is any Playwright selector (css, text=, role=, xpath), so you can target anything in the DOM, not just the listed elements. Use type_text({ selector, text }) for inputs (elementId is also accepted). After every action, inspect the returned state before continuing. Use get_current_state() after user interaction, asynchronous page updates, or when the page may have changed.

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
  Read contentMarkdown and elements (discovery context).

Need to act on a target?
  Use click({ selector }) or type_text({ selector, text }) with any Playwright selector.
  Build selectors from visible text (text=...), roles (role=...), CSS, or xpath.
  Use point {x,y} only as a raw coordinate last resort.

Page may have changed?
  Use get_current_state().

DOM is insufficient?
  Explain why, then use screenshot as last fallback.

Human-only step?
  Ask user to act in visible browser, then call get_current_state().
```
