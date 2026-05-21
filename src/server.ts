#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";
import { z } from "zod";

const USER_AGENT =
  process.env.DOMCP_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 DOMCP/0.1";
const REQUEST_DELAY_MS = Number.parseInt(process.env.DOMCP_REQUEST_DELAY_MS ?? "1000", 10);
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.DOMCP_FETCH_TIMEOUT_MS ?? "15000", 10);
const NAVIGATION_TIMEOUT_MS = Number.parseInt(process.env.DOMCP_NAVIGATION_TIMEOUT_MS ?? "30000", 10);
const THIN_CONTENT_CHARS = Number.parseInt(process.env.DOMCP_THIN_CONTENT_CHARS ?? "200", 10);
const MAX_ELEMENTS = Number.parseInt(process.env.DOMCP_MAX_ELEMENTS ?? "80", 10);
const USER_DATA_DIR = process.env.DOMCP_USER_DATA_DIR?.trim();
const ACTIONABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
  "[matripple]",
  ".mat-ripple",
  "mat-list-item",
].join(", ");

function envFlag(value: string | undefined, defaultValue: boolean) {
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const HEADLESS = envFlag(process.env.DOMCP_HEADLESS, true);
const BROWSER_FIRST_WITH_PROFILE = envFlag(process.env.DOMCP_BROWSER_FIRST_WITH_PROFILE, Boolean(USER_DATA_DIR));
const AI_AGENT_GUIDE_URL = new URL("../AI_AGENT_GUIDE.md", import.meta.url);

type ActionableElement = {
  id: number;
  role: "link" | "button" | "input" | "textarea";
  text: string;
  href?: string;
};

type InternalActionableElement = ActionableElement & {
  selectorIndex: number;
};

type BrowserActionableElement = {
  selectorIndex: number;
  visible: boolean;
  role: ActionableElement["role"];
  text: string;
  href?: string;
};

type ToolPayload = Record<string, unknown> | string;

type RobotsRules = {
  fetchedAt: number;
  crawlDelayMs?: number;
  disallow: string[];
  allow: string[];
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let currentElements: InternalActionableElement[] = [];
let currentContentMarkdown = "";

const robotsCache = new Map<string, RobotsRules>();
const lastRequestAt = new Map<string, number>();

function textResponse(payload: ToolPayload) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return textResponse({
    ok: false,
    error: message,
  });
}

async function withToolErrors<T>(handler: () => Promise<T>) {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

function getOrigin(url: URL) {
  return `${url.protocol}//${url.host}`;
}

function normalizePathForRobots(url: URL) {
  return `${url.pathname}${url.search}`;
}

async function sleep(ms: number) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function respectfulDelay(url: URL) {
  const origin = getOrigin(url);
  const robots = await getRobotsRules(url);
  const delay = Math.max(REQUEST_DELAY_MS, robots.crawlDelayMs ?? 0);
  const elapsed = Date.now() - (lastRequestAt.get(origin) ?? 0);
  await sleep(Math.max(0, delay - elapsed));
  lastRequestAt.set(origin, Date.now());
}

function parseRobotsTxt(text: string): RobotsRules {
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; crawlDelayMs?: number }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[]; crawlDelayMs?: number } | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      current = { agents: [value.toLowerCase()], disallow: [], allow: [] };
      groups.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === "disallow" && value) {
      current.disallow.push(value);
    } else if (key === "allow" && value) {
      current.allow.push(value);
    } else if (key === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) {
        current.crawlDelayMs = Math.max(0, seconds * 1000);
      }
    }
  }

  const exact = groups.find((group) => group.agents.some((agent) => USER_AGENT.toLowerCase().includes(agent)));
  const wildcard = groups.find((group) => group.agents.includes("*"));
  const selected = exact ?? wildcard;

  return {
    fetchedAt: Date.now(),
    crawlDelayMs: selected?.crawlDelayMs,
    disallow: selected?.disallow ?? [],
    allow: selected?.allow ?? [],
  };
}

function robotsPatternMatches(pattern: string, path: string) {
  if (pattern === "") {
    return false;
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}`);
  return regex.test(path);
}

async function getRobotsRules(url: URL): Promise<RobotsRules> {
  const origin = getOrigin(url);
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) {
    return cached;
  }

  const rulesUrl = new URL("/robots.txt", origin);
  try {
    const response = await fetch(rulesUrl, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const rules = response.ok
      ? parseRobotsTxt(await response.text())
      : { fetchedAt: Date.now(), disallow: [], allow: [] };
    robotsCache.set(origin, rules);
    return rules;
  } catch {
    const rules = { fetchedAt: Date.now(), disallow: [], allow: [] };
    robotsCache.set(origin, rules);
    return rules;
  }
}

async function assertRobotsAllowed(rawUrl: string) {
  const url = new URL(rawUrl);
  const rules = await getRobotsRules(url);
  const path = normalizePathForRobots(url);
  const longestAllow = rules.allow.filter((rule) => robotsPatternMatches(rule, path)).sort((a, b) => b.length - a.length)[0];
  const longestDisallow = rules.disallow
    .filter((rule) => robotsPatternMatches(rule, path))
    .sort((a, b) => b.length - a.length)[0];

  if (longestDisallow && (!longestAllow || longestDisallow.length > longestAllow.length)) {
    throw new Error(`Blocked by robots.txt for ${url.origin}${longestDisallow}`);
  }
}

async function fetchWithRetries(url: string, attempts = 2): Promise<string> {
  const parsed = new URL(url);
  await assertRobotsAllowed(url);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await respectfulDelay(parsed);
      const response = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(500 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function htmlToMarkdown(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document, {
    keepClasses: false,
  });
  const article = reader.parse();
  const htmlForMarkdown = article?.content ?? dom.window.document.body?.innerHTML ?? "";
  const markdown = turndown.turndown(htmlForMarkdown).replace(/\n{3,}/g, "\n\n").trim();

  return {
    title: article?.title ?? dom.window.document.title ?? "",
    markdown,
  };
}

async function ensureBrowser() {
  if (!context) {
    const contextOptions = {
      userAgent: USER_AGENT,
      viewport: { width: 1365, height: 900 },
    };

    if (USER_DATA_DIR) {
      // A persistent profile lets a human log in once in a visible Playwright browser,
      // then reuse the saved cookies/session on later MCP calls and restarts.
      context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        ...contextOptions,
        headless: HEADLESS,
      });
    } else {
      browser = await chromium.launch({ headless: HEADLESS });
      context = await browser.newContext(contextOptions);
    }

    context.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  }

  if (!page || page.isClosed()) {
    page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
  }

  return page;
}

async function closeBrowser() {
  await page?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  page = undefined;
  context = undefined;
  browser = undefined;
  currentElements = [];
  currentContentMarkdown = "";
}

async function gotoRespectfully(url: string) {
  await assertRobotsAllowed(url);
  await respectfulDelay(new URL(url));
  const activePage = await ensureBrowser();
  await activePage.goto(url, { waitUntil: "networkidle", timeout: NAVIGATION_TIMEOUT_MS });
  return activePage;
}

function readableText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

// Keep this page-side function as runtime-created JavaScript. Dev runners such
// as tsx/esbuild can wrap inline callbacks in __name(...), and Playwright then
// serializes that wrapper into the browser context where __name is undefined.
const collectActionableElementsInPage = new Function(
  "nodes",
  `
const results = [];

for (let index = 0; index < nodes.length; index += 1) {
  const element = nodes[index];
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const visible =
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.width > 0 &&
    rect.height > 0;

  const tag = element.tagName.toLowerCase();
  const declaredRole = element.getAttribute("role");
  const role =
    tag === "a" || declaredRole === "link"
      ? "link"
      : tag === "textarea"
        ? "textarea"
        : tag === "input"
          ? "input"
          : "button";

  const aria = element.getAttribute("aria-label");
  const title = element.getAttribute("title");
  const placeholder = element.getAttribute("placeholder");
  const value = element instanceof HTMLInputElement ? element.value : "";
  const text = element.textContent;
  const href = element instanceof HTMLAnchorElement ? element.href : undefined;

  results.push({
    selectorIndex: index,
    visible,
    role,
    text: (aria || title || placeholder || value || text || "").replace(/\\s+/g, " ").trim(),
    href,
  });
}

return results.filter((element) => element.visible);
`,
) as (nodes: Element[]) => BrowserActionableElement[];

async function getRenderedMarkdown(activePage: Page) {
  const html = await activePage.content();
  const { markdown } = htmlToMarkdown(html, activePage.url());
  return markdown;
}

async function collectActionableElements(activePage: Page): Promise<InternalActionableElement[]> {
  const elements = await activePage
    .locator(ACTIONABLE_SELECTOR)
    .evaluateAll(collectActionableElementsInPage);

  return elements
    .filter((element) => element.text || element.href)
    .slice(0, MAX_ELEMENTS)
    .map((element, id) => ({
      id,
      role: element.role as ActionableElement["role"],
      text: readableText(element.text || element.href),
      href: element.href,
      selectorIndex: element.selectorIndex,
    }));
}

function publicElements(elements: InternalActionableElement[]): ActionableElement[] {
  return elements.map(({ selectorIndex: _selectorIndex, ...element }) => element);
}

async function pageState(activePage: Page) {
  currentContentMarkdown = await getRenderedMarkdown(activePage);
  currentElements = await collectActionableElements(activePage);
  return {
    url: activePage.url(),
    contentMarkdown: currentContentMarkdown,
    elements: publicElements(currentElements),
  };
}

async function extractContent(rawUrl: string) {
  if (BROWSER_FIRST_WITH_PROFILE) {
    // When a persistent profile is configured, Chromium owns the logged-in cookies.
    // Native fetch cannot see them, so browser-first extraction avoids reading a login page by mistake.
    const renderedPage = await gotoRespectfully(rawUrl);
    return getRenderedMarkdown(renderedPage);
  }

  // DOM-first path: native fetch is cheap, fast, and avoids launching a browser for static pages.
  const html = await fetchWithRetries(rawUrl);
  const fetched = htmlToMarkdown(html, rawUrl);
  if (fetched.markdown.length >= THIN_CONTENT_CHARS) {
    return fetched.markdown;
  }

  // Escalate only when static HTML is too thin, which usually means JS rendered the useful DOM.
  const renderedPage = await gotoRespectfully(rawUrl);
  const rendered = await getRenderedMarkdown(renderedPage);
  return rendered || fetched.markdown;
}

async function clickCurrentElement(elementId: number) {
  const activePage = await ensureBrowser();
  const element = currentElements.find((item) => item.id === elementId);
  if (!element) {
    throw new Error(`No element with id ${elementId}. Call navigate() or get_current_state() first.`);
  }

  const target = activePage.locator(ACTIONABLE_SELECTOR).nth(element.selectorIndex);

  await Promise.all([
    activePage.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined),
    activePage.waitForNavigation({ waitUntil: "networkidle", timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined),
    target.click({ timeout: NAVIGATION_TIMEOUT_MS }),
  ]);

  return pageState(activePage);
}

async function typeIntoCurrentElement(elementId: number, text: string) {
  const activePage = await ensureBrowser();
  const element = currentElements.find((item) => item.id === elementId);
  if (!element) {
    throw new Error(`No element with id ${elementId}. Call navigate() or get_current_state() first.`);
  }

  if (element.role !== "input" && element.role !== "textarea") {
    throw new Error(`Element ${elementId} is a ${element.role}, not a text input.`);
  }

  const target = activePage.locator(ACTIONABLE_SELECTOR).nth(element.selectorIndex);
  await target.fill(text, { timeout: NAVIGATION_TIMEOUT_MS });
  await pageState(activePage);
  return { ok: true };
}

async function getAgentGuide() {
  return readFile(AI_AGENT_GUIDE_URL, "utf8");
}

const server = new McpServer({
  name: "domcp",
  version: "0.1.0",
}, {
  instructions:
    "Use DOMCP as a DOM-first browser tool. For substantial browsing tasks, first load the MCP prompt /mcp__domcp__agent_guide when the client supports MCP prompts. Prefer navigate and get_current_state to read content and discover numbered action targets, then use click or type_text for interaction. Use screenshot only as a last fallback when DOM content/action targets are insufficient. Explain why before using screenshot.",
});

server.prompt(
  "agent_guide",
  "Load the DOMCP AI-agent workflow guide, including DOM-first browsing, visible-browser handoff, and screenshot-last rules.",
  async () => ({
    description: "DOMCP AI-agent workflow guide",
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: await getAgentGuide(),
        },
      },
    ],
  }),
);

server.tool(
  "extract_content",
  "Extract readable markdown from a URL. Uses fetch first, then escalates to Chromium only if the fetched content is too thin.",
  { url: z.string().url() },
  async ({ url }) =>
    withToolErrors(async () => {
      const markdown = await extractContent(url);
      return textResponse(markdown);
    }),
);

server.tool(
  "navigate",
  "Navigate the persistent Chromium page and return cleaned readable content plus numbered DOM action targets.",
  { url: z.string().url() },
  async ({ url }) =>
    withToolErrors(async () => {
      const activePage = await gotoRespectfully(url);
      return textResponse(await pageState(activePage));
    }),
);

server.tool(
  "click",
  "Click a numbered element from the current page, handling both normal links and JavaScript click handlers.",
  { elementId: z.number().int().nonnegative() },
  async ({ elementId }) =>
    withToolErrors(async () => {
      return textResponse(await clickCurrentElement(elementId));
    }),
);

server.tool(
  "type_text",
  "Fill a numbered input or textarea element on the current page.",
  { elementId: z.number().int().nonnegative(), text: z.string() },
  async ({ elementId, text }) =>
    withToolErrors(async () => {
      return textResponse(await typeIntoCurrentElement(elementId, text));
    }),
);

server.tool(
  "screenshot",
  "Last fallback only. Before calling screenshot, explain why DOM content/action targets from navigate or get_current_state are insufficient, such as canvas/WebGL, visually ambiguous pages, or broken DOM extraction.",
  {},
  async () =>
    withToolErrors(async () => {
      const activePage = await ensureBrowser();
      const image = await activePage.screenshot({ fullPage: true, type: "png" });
      return {
        content: [
          {
            type: "image" as const,
            data: image.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    }),
);

server.tool(
  "get_current_state",
  "Return the current persistent browser page URL, readable content, and numbered action targets without navigating.",
  {},
  async () =>
    withToolErrors(async () => {
      const activePage = await ensureBrowser();
      return textResponse(await pageState(activePage));
    }),
);

server.tool(
  "close",
  "Close the persistent browser context and clean up resources.",
  {},
  async () =>
    withToolErrors(async () => {
      await closeBrowser();
      return textResponse({ ok: true });
    }),
);

process.on("SIGINT", () => {
  void closeBrowser().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void closeBrowser().finally(() => process.exit(0));
});

const transport = new StdioServerTransport();
await server.connect(transport);
