#!/usr/bin/env node
// HexRace browser driver: boots the production server, opens N Chromium
// pages, joins the lobby, plays a full (fast-mode) match by clicking the
// real UI, screenshots every phase it sees, and exits non-zero on any
// page error. Playwright must be importable (see SKILL.md).
//
//   node .claude/skills/run-hexrace/driver.mjs [--players 2] [--fast 8]
//        [--out /tmp/hexrace-shots] [--port 3217] [--timeout 180]

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// resolve playwright from the repo, or from a scratch install
let chromium;
for (const base of [root, '/tmp/hexrace-verify', process.cwd()]) {
  try {
    ({ chromium } = createRequire(path.join(base, 'package.json'))('playwright'));
    break;
  } catch { /* try next */ }
}
if (!chromium) {
  console.error('playwright not found — npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PLAYERS = Number(arg('players', 2));
const FAST = arg('fast', '8');
const OUT = arg('out', '/tmp/hexrace-shots');
const PORT = arg('port', '3217');
const TIMEOUT = Number(arg('timeout', 180)) * 1000;

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- server
const server = spawn('node', ['server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT, HEXRACE_FAST: FAST },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const stop = (code) => { server.kill(); process.exit(code); };
process.on('SIGINT', () => stop(130));

await new Promise(r => setTimeout(r, 800));
const url = `http://localhost:${PORT}`;

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();
const errors = [];
const pages = [];
const NAMES = ['Hostess', 'Guestina', 'Cyx', 'Drustа', 'Elvira', 'Fenwick', 'Grizel', 'Hagatha'];

for (let i = 0; i < PLAYERS; i++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(`[${NAMES[i]}] pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().includes('WebSocket')) {
      errors.push(`[${NAMES[i]}] console.error: ${m.text()}`);
    }
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.fill('input[type="text"]', NAMES[i]);
  await page.click('button:has-text("Enter the Lobby")');
  pages.push(page);
}
const host = pages[0];

await host.waitForFunction((n) => window.__hexrace?.players === n, PLAYERS, { timeout: 10_000 });
await snap(host, 'lobby');

// guests ready up, host starts
for (const p of pages.slice(1)) await p.click('button:has-text("Ready Up")');
await host.click(`button:has-text("${PLAYERS < 2 ? 'Start solo practice' : 'Start the Match'}")`);
console.log(`✓ lobby: ${PLAYERS} players joined, match started`);

// ------------------------------------------------------------ match loop
const phase = (p) => p.evaluate(() => window.__hexrace ?? {});
const shot = new Set();
let flying = false;
const t0 = Date.now();
let last = '';

while (Date.now() - t0 < TIMEOUT) {
  const { phase: ph, round } = await phase(host);
  const key = `${round}-${ph}`;
  if (ph && key !== last) { last = key; console.log(`  phase: round ${round} → ${ph}`); }

  if (ph === 'race' && !flying) {
    flying = true;
    // hold boost + gentle weave on every page so trails/cam are visible
    for (const p of pages) {
      await p.keyboard.down('Shift');
      await p.keyboard.down(Math.random() < 0.5 ? 'KeyA' : 'KeyD');
    }
    await new Promise(r => setTimeout(r, 1200));   // let them get moving
  }
  if (ph !== 'race' && flying) {
    flying = false;
    for (const p of pages) {
      await p.keyboard.up('Shift');
      await p.keyboard.up('KeyA').catch(() => {});
      await p.keyboard.up('KeyD').catch(() => {});
    }
  }

  if (ph && !shot.has(key)) {
    shot.add(key);
    await snap(host, `r${round}-${ph}`);
  }

  // drive phase UIs through real clicks
  if (ph === 'pantry') {
    for (const p of pages) {
      const card = p.locator('.ing-card:not(.taken):not(.disabled)').first();
      if (await card.count() && await card.isVisible().catch(() => false)) {
        await card.click({ timeout: 300 }).catch(() => {});
      }
    }
  }
  if (ph === 'cauldron' && !shot.has(`${round}-book`)) {
    shot.add(`${round}-book`);
    await host.click('button:has-text("Recipe book")', { timeout: 500 }).catch(() => {});
    await snap(host, `r${round}-cauldron-book`);
    for (const p of pages) await p.click('button:has-text("Finish brewing")', { timeout: 300 }).catch(() => {});
  }
  if (ph === 'deploy') {
    for (const p of pages) await p.click('button:has-text("Lock in")', { timeout: 300 }).catch(() => {});
  }
  if (ph === 'podium') {
    await new Promise(r => setTimeout(r, 300));
    await snap(host, 'podium');
    break;
  }
  await new Promise(r => setTimeout(r, 120));
}

const reached = shot.has('podium') || last.endsWith('podium');
console.log(`\nScreenshots in ${OUT}: ${[...shot].join(', ')}`);
if (errors.length) {
  console.error(`\n✗ ${errors.length} page error(s):`);
  for (const e of [...new Set(errors)].slice(0, 12)) console.error('  ' + e);
}
if (!reached) console.error('✗ match did not reach the podium in time');
console.log(reached && !errors.length ? '\n✅ full match played in the browser, no page errors' : '\n❌ FAILED');
console.log('\n--- server log ---\n' + serverLog.split('\n').slice(0, 8).join('\n'));

await browser.close();
stop(reached && !errors.length ? 0 : 1);

async function snap(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}
