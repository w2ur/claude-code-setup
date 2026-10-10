#!/usr/bin/env node
// Runs the design-direction skill's dna.js on a page in the installed Google
// Chrome and prints its JSON on stdout. dna.js is written for the Playwright
// MCP's browser_evaluate; this harness exists because the MCP may refuse
// file:// targets, so local fixtures and builds go through here.
// Usage: dna-harness.mjs <url|file> [light|dark]
// Exit 0 = DNA printed · 2 = could not run (navigation failed, script error,
// or a page with no visible text, whose DNA would describe nothing).
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DNA = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../skills/design-direction/references/dna.js');

async function main() {
  const [target, scheme = 'light'] = process.argv.slice(2);
  if (!target || !['light', 'dark'].includes(scheme)) { console.error('usage: dna-harness.mjs <url|file> [light|dark]'); return 2; }
  const url = /^https?:/.test(target) ? target : pathToFileURL(path.resolve(target)).href;

  let browser;
  try {
    const source = (await readFile(DNA, 'utf8')).trim();
    browser = await chromium.launch({ channel: 'chrome' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready);
    const dna = await page.evaluate(`(${source})()`);
    if (!dna.fonts.length) { console.error(`no visible text on ${url}`); return 2; }
    process.stdout.write(JSON.stringify(dna, null, 2) + '\n');
    return 0;
  } catch (err) {
    console.error(String(err));
    return 2;
  } finally {
    await browser?.close();
  }
}

process.exitCode = await main();
