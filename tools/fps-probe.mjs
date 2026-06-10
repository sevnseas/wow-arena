#!/usr/bin/env node
/**
 * Headless FPS probe — loads the game, waits for assets, then counts
 * requestAnimationFrame ticks over a fixed window. SwiftShader (CPU) numbers
 * are far below real-GPU FPS but are a stable relative benchmark for
 * before/after perf comparisons.
 *
 * Usage: node tools/fps-probe.mjs [--url=...] [--seconds=6] [--warmup=4000]
 */

import puppeteer from 'puppeteer';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const url = args.url || 'http://localhost:3000/threejs-arena/?mode=standalone';
const seconds = parseFloat(args.seconds || '6');
const warmup = parseInt(args.warmup || '5000', 10);

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox', '--headless=new', '--enable-webgl', '--ignore-gpu-blocklist',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
    '--disable-gpu-sandbox',
  ],
  defaultViewport: { width: parseInt(args.w || "1280", 10), height: parseInt(args.h || "720", 10) },
});

const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await new Promise(r => setTimeout(r, warmup));

const fps = await page.evaluate((secs) => new Promise((resolve) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - t0 < secs * 1000) requestAnimationFrame(tick);
    else resolve(frames / secs);
  };
  requestAnimationFrame(tick);
}), seconds);

const info = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__game;
  if (!g?.renderer) { resolve(null); return; }
  // renderer.info resets each render — sample right after a frame completes.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const r = g.renderer.info;
    const grass = g.scene.getObjectByName('GrassField');
    let visibleTiles = 0;
    resolve({
      calls: r.render.calls,
      triangles: r.render.triangles,
      grassTiles: grass ? grass.children.length : 0,
    });
  }));
}));

console.log(JSON.stringify({ fps: Math.round(fps * 10) / 10, ...info }, null, 2));
await browser.close();
