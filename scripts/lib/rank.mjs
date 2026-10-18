// Rank a township exactly as the web app does (same buildSites, shading raycast and scoreSites),
// so offline validation and sensitivity runs match what judges see in the browser.
import { readFile } from 'node:fs/promises';
import { DEFAULT_ASSUMPTIONS, buildSites, scoreSites, isViable } from '../../src/solar.js';
import { computeShading } from '../../src/shading.js';

export { TOWNSHIPS } from '../../src/townships.js';

export async function loadTownship(id) {
  return JSON.parse(await readFile(new URL(`../../public/data/${id}.json`, import.meta.url), 'utf8'));
}

// Build sites and run the shading raycast once (shading does not depend on assumptions).
export function prepare(raw) {
  const { sites, origin } = buildSites(raw);
  const items = sites.map((s) => ({ xy: s.xy, bbox: s.bbox, height: s.height, centroid: s.centroid, skip: s.category === 'carpark' }));
  const shading = computeShading(items, origin[1], origin[0]);
  sites.forEach((s, i) => (s.shading = s.category === 'carpark' ? 0.95 : shading[i]));
  return sites;
}

// Score with the given assumptions and return viable sites, best first (the app's Top sites).
export function rank(sites, assumptions = DEFAULT_ASSUMPTIONS) {
  scoreSites(sites, { ...DEFAULT_ASSUMPTIONS, ...assumptions });
  return sites.filter(isViable).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

// Deterministic PRNG (mulberry32) for reproducible samples.
export function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
export const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))].join('\n') + '\n';

// Minimal CSV reader (quoted fields, doubled quotes) for the filled-in sheets.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export const townshipIds = (argv, all) => (argv.length ? argv : Object.keys(all));
export const outPath = (id, name) => new URL(`../../data/processed/${id}/${name}`, import.meta.url);
