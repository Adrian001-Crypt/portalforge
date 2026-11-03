/**
 * Render docs/pitch (deck.json + slides/*.html, the same sources as the Slides artifact) to
 * docs/pitch/portalforge-pitch.pdf at 1920×1080 per page with system Chrome. Speaker notes are omitted.
 *   npx tsx scripts/media/build-deck-pdf.ts
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const deck = JSON.parse(readFileSync('docs/pitch/deck.json', 'utf8'));
const fonts = Object.values(deck.faces as Record<string, { href?: string }>).map((f) => f.href).filter(Boolean).map((h) => `<link rel="stylesheet" href="${h}">`).join('\n');
const slides = (deck.order as string[]).map((id) => readFileSync(`docs/pitch/slides/${id}.html`, 'utf8')).join('\n');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${deck.title}</title>${fonts}
<style>
  @page { size: 1920px 1080px; margin: 0 }
  html, body { margin: 0; padding: 0 }
  section { width: 1920px; height: 1080px; box-sizing: border-box; position: relative; overflow: hidden; break-after: page; }
  section * { margin: 0; box-sizing: border-box }
  section ul, section ol { padding-left: 1.2em }
  section li + li { margin-top: 0.25em }
  section table { border-collapse: collapse; width: 100% }
  section th { font-weight: 600; text-align: left; border-bottom: 2px solid #CBD2DC }
  section th, section td { padding: 0.35em 0.6em; vertical-align: top }
  section td { border-bottom: 1px solid #DDE2EA }
  aside { display: none }
</style></head><body>${slides}</body></html>`;
writeFileSync('docs/pitch/portalforge-pitch.html', html);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto(`file://${process.cwd()}/docs/pitch/portalforge-pitch.html`);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(800);
await p.pdf({ path: 'docs/pitch/portalforge-pitch.pdf', width: '1920px', height: '1080px', printBackground: true });
await b.close();
console.log(`wrote docs/pitch/portalforge-pitch.pdf (${deck.order.length} slides)`);
