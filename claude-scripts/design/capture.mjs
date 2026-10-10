#!/usr/bin/env node
// Captures a page at two widths in both colour schemes (full page + fold),
// plus one keyboard-focus frame, using the installed Google Chrome.
// Exit 0 = captured · 2 = could not run (navigation failed, HTTP error status,
// or blank page). A page with almost no visible text is a blank SPA shell or
// an error page: that is UNKNOWN, never "clean".
// Writes <outdir>/capture.json (url, finalUrl, status, redirectedPath, title,
// textLength, hasDarkScheme) and <outdir>/console.json (console errors and
// uncaught page errors seen during the 1440-light load, as [{type, text}]).
// capture.json also holds foldScrollY, the scrollY observed just before each
// fold shot keyed <width>-<scheme>; any non-zero value exits 2.
// Evidence from an earlier run in the same <outdir> is removed first.
// THIS SCRIPT IS THE SOURCE OF TRUTH for viewports, the blank threshold and
// the scroll bound.
import { chromium } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 390, h: 844 }];
const SCHEMES = ['light', 'dark'];
const MIN_TEXT = 80; // characters of visible text below which a page counts as blank
const MAX_SCROLL_STEPS = 40; // viewport-heights scrolled to trigger lazy content; bounds infinite-scroll pages
const SCROLL_TOP_WAIT_MS = 2000; // bound on settling scrollY at 0 after the scroll back (smooth-scroll sites animate)

// 'networkidle' never fires on sites that poll or beacon; wait for load, then
// give the network a bounded chance to settle, then fonts, then lazy images.
// The scroll target is frozen before the loop: an infinite-scroll page grows
// as it is scrolled, so reading the height inside the loop never terminates.
async function settle(page, url) {
  const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(async (maxSteps) => {
    const target = document.body.scrollHeight;
    const step = window.innerHeight;
    for (let i = 0, y = 0; i < maxSteps && y < target; i++, y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 100));
    }
  }, MAX_SCROLL_STEPS);
  await scrollToTop(page);
  return response;
}

// html { scroll-behavior: smooth } makes a plain scrollTo animate, and an
// animation already in flight from the lazy-content loop can resume after an
// instant jump. So jump instantly, then re-jump until scrollY has read 0 twice
// in a row, bounded by SCROLL_TOP_WAIT_MS. The caller records the final scrollY.
async function scrollToTop(page) {
  await page.evaluate(async (budget) => {
    const deadline = Date.now() + budget;
    for (let still = 0; still < 2 && Date.now() < deadline;) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      await new Promise(r => setTimeout(r, 100));
      still = window.scrollY === 0 ? still + 1 : 0;
    }
  }, SCROLL_TOP_WAIT_MS);
}

// The colours a visitor sees: the first non-transparent background walking up
// from the element at the viewport centre, plus html and body background and
// text colour. A theme set on a wrapper div (body left transparent) still
// shows up here.
function schemeColours() {
  const opaque = (c) => c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
  const cs = (el) => getComputedStyle(el);
  let centreBg = 'none';
  for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el; el = el.parentElement) {
    if (opaque(cs(el).backgroundColor)) { centreBg = cs(el).backgroundColor; break; }
  }
  const html = document.documentElement, body = document.body;
  return [centreBg, cs(html).backgroundColor, cs(html).color, cs(body).backgroundColor, cs(body).color].join('|');
}

async function main() {
  const [target, outdir] = process.argv.slice(2);
  if (!target || !outdir) { console.error('usage: capture.mjs <url|file> <outdir>'); return 2; }
  const url = /^https?:/.test(target) ? target : pathToFileURL(path.resolve(target)).href;
  const shots = path.join(outdir, 'shots');
  for (const stale of ['capture.json', 'console.json', 'shots']) {
    await rm(path.join(outdir, stale), { recursive: true, force: true });
  }
  await mkdir(shots, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    const meta = { url };
    const colours = {};
    const foldScrollY = {};
    const consoleErrors = [];
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: scheme });
        const page = await ctx.newPage();
        const primary = vp.w === 1440 && scheme === 'light';
        if (primary) {
          page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push({ type: 'error', text: msg.text() }); });
          page.on('pageerror', (err) => consoleErrors.push({ type: 'pageerror', text: String(err) }));
        }
        const response = await settle(page, url);
        if (vp.w === 1440) colours[scheme] = await page.evaluate(schemeColours);
        if (primary) {
          meta.status = response?.status() ?? null; // null for file:// targets
          meta.finalUrl = page.url();
          meta.redirectedPath = new URL(meta.finalUrl).pathname !== new URL(url).pathname;
          meta.title = await page.title();
          meta.textLength = (await page.evaluate(() => document.body?.innerText ?? '')).trim().length;
          await writeFile(path.join(outdir, 'console.json'), JSON.stringify(consoleErrors, null, 2));
          if (meta.status !== null && meta.status >= 400) {
            await writeFile(path.join(outdir, 'capture.json'), JSON.stringify(meta, null, 2));
            console.error(`error page: HTTP ${meta.status}`);
            return 2;
          }
        }
        foldScrollY[`${vp.w}-${scheme}`] = await page.evaluate(() => window.scrollY);
        await page.screenshot({ path: path.join(shots, `${vp.w}-${scheme}-fold.png`) });
        await page.screenshot({ path: path.join(shots, `${vp.w}-${scheme}.png`), fullPage: true });
        if (primary) {
          await page.keyboard.press('Tab');
          await page.screenshot({ path: path.join(shots, '1440-light-focus.png') });
        }
        await ctx.close();
      }
    }
    // A real dark scheme changes the rendered colours; no CSS parsing
    // (nested @media, @layer, cross-origin sheets all defeat it).
    meta.hasDarkScheme = colours.light !== colours.dark;
    meta.foldScrollY = foldScrollY;
    await writeFile(path.join(outdir, 'capture.json'), JSON.stringify(meta, null, 2));
    const offTop = Object.entries(foldScrollY).filter(([, y]) => y !== 0);
    if (offTop.length) { console.error(`could not capture the first screen: scrollY not 0 for ${offTop.map(([k, y]) => `${k}=${y}`).join(', ')}`); return 2; }
    if (meta.textLength < MIN_TEXT) { console.error(`blank page: ${meta.textLength} chars of text`); return 2; }
    return 0;
  } catch (err) {
    console.error(String(err));
    return 2;
  } finally {
    await browser?.close();
  }
}

process.exitCode = await main();
