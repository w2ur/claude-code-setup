#!/usr/bin/env node
// Reads one inspiration-gallery page in the installed Google Chrome and prints
// what a browser sees: title, headings, and every link with its text and alt
// text, as JSON on stdout. Galleries refuse curl (403/429) but load in a real
// browser; this script gives each audit agent its own Chrome, because the
// Playwright MCP browser is shared and parallel agents would collide in it.
// Usage: gallery.mjs <url>
// Exit 0 = page read · 2 = could not run (navigation failed, HTTP error
// status, or a page with no links, which is a wall or an error page, never
// an empty gallery).
import { chromium } from 'playwright-core';

const SCROLL_STEPS = 6; // viewport-heights scrolled so lazy-loaded cards render

async function main() {
  const [url] = process.argv.slice(2);
  if (!url || !/^https?:/.test(url)) { console.error('usage: gallery.mjs <url>'); return 2; }

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    // Headless Chrome announces itself as HeadlessChrome; several galleries answer that with 403.
    const userAgent = (await browser.newPage().then(async (p) => { const ua = await p.evaluate(() => navigator.userAgent); await p.close(); return ua; })).replace('HeadlessChrome', 'Chrome');
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent })).newPage();
    const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    if (res && res.status() >= 400) { console.error(`HTTP ${res.status()} on ${url}`); return 2; }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    for (let i = 0; i < SCROLL_STEPS; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(400);
    }
    const out = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const links = [...document.querySelectorAll('a[href]')].map((a) => ({
        text: clean(a.innerText).slice(0, 120),
        alt: clean([...a.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ')).slice(0, 120),
        href: a.href,
      })).filter((l) => (l.text || l.alt) && /^https?:/.test(l.href));
      const seen = new Set();
      return {
        finalUrl: location.href,
        title: document.title,
        headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => clean(h.innerText)).filter(Boolean).slice(0, 80),
        links: links.filter((l) => !seen.has(l.href) && seen.add(l.href)),
      };
    });
    if (!out.links.length) { console.error(`no links on ${url}: a wall or an error page`); return 2; }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (err) {
    console.error(String(err));
    return 2;
  } finally {
    await browser?.close();
  }
}

process.exitCode = await main();
