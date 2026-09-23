import dotenv from 'dotenv';
import express from 'express';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matches, mapHay, searchQuery } from './match.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const {
  PLEX_URL, PLEX_TOKEN, PLEX_SECTION_ID = '5', PLEX_ACCOUNT_ID = '1',
  PORT = 3100, BS_MAPS_DIRS = '',
} = process.env;

if (!PLEX_URL || !PLEX_TOKEN) {
  console.error('PLEX_URL et PLEX_TOKEN sont requis dans .env');
  process.exit(1);
}

// ---------- Stockage JSON ----------

async function loadJson(file, fallback) {
  try { return JSON.parse(await readFile(path.join(ROOT, file), 'utf8')); } catch { return fallback; }
}
async function saveJson(file, data) {
  await mkdir(path.dirname(path.join(ROOT, file)), { recursive: true });
  await writeFile(path.join(ROOT, file), JSON.stringify(data));
}

// ---------- Plex ----------

async function plex(p, params = {}) {
  const url = new URL(p, PLEX_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Plex-Token': PLEX_TOKEN } });
  if (!res.ok) throw new Error(`Plex ${p} → ${res.status}`);
  return (await res.json()).MediaContainer;
}

const toTrack = t => ({
  key: t.ratingKey,
  title: t.title,
  artist: t.originalTitle || t.grandparentTitle || '',
  album: t.parentTitle || '',
  rating: t.userRating || 0,
  plays: t.viewCount || 0,
  lastPlayed: t.lastViewedAt || t.viewedAt || 0,
  thumb: t.parentThumb || t.thumb || t.grandparentThumb || null,
});

async function getTracks(source, limit) {
  const page = { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': limit };
  const section = `/library/sections/${PLEX_SECTION_ID}/all`;

  if (source === 'favorites') {
    const mc = await plex(section, { type: 10, 'userRating>>': 0, sort: 'userRating:desc,viewCount:desc', ...page });
    return (mc.Metadata || []).map(toTrack);
  }
  if (source === 'played') {
    const mc = await plex(section, { type: 10, sort: 'viewCount:desc', ...page });
    return (mc.Metadata || []).map(toTrack);
  }
  if (source === 'recent') {
    const mc = await plex('/status/sessions/history/all', {
      sort: 'viewedAt:desc', librarySectionID: PLEX_SECTION_ID, accountID: PLEX_ACCOUNT_ID,
      'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': limit * 5,
    });
    const seen = new Set();
    const out = [];
    for (const t of mc.Metadata || []) {
      const id = `${t.grandparentTitle}|${t.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(toTrack(t));
      if (out.length >= limit) break;
    }
    return out;
  }
  throw new Error(`source inconnue : ${source}`);
}

// ---------- Maps installées (BSManager) ----------

let installed = null; // { maps: [{key, hay, name}], keys: Set }

async function readInfo(dir) {
  for (const name of ['Info.dat', 'info.dat']) {
    try {
      const info = JSON.parse((await readFile(path.join(dir, name), 'utf8')).replace(/^﻿/, ''));
      if (info.song) { // format v4
        return { songName: info.song.title, songSubName: info.song.subTitle, songAuthorName: info.song.author };
      }
      return { songName: info._songName, songSubName: info._songSubName, songAuthorName: info._songAuthorName };
    } catch { /* suivant */ }
  }
  return null;
}

async function scanInstalled() {
  const maps = [];
  const keys = new Set();
  for (const dir of BS_MAPS_DIRS.split(';').map(s => s.trim()).filter(Boolean)) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) {
      console.warn(`Dossier de maps illisible : ${dir} (${e.code})`);
      continue;
    }
    await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
      const key = e.name.match(/^([0-9a-f]{1,6})[\s-]/i)?.[1]?.toLowerCase() ?? null;
      if (key) keys.add(key);
      const meta = await readInfo(path.join(dir, e.name));
      if (meta) maps.push({ key, hay: mapHay(meta), name: `${meta.songAuthorName} - ${meta.songName}` });
    }));
  }
  installed = { maps, keys, scannedAt: Date.now() };
  console.log(`${maps.length} maps installées indexées`);
  return installed;
}

const installedFor = track => installed.maps.filter(m => matches(track, m.hay));

// ---------- BeatSaver ----------

const CACHE_FILE = 'cache/beatsaver.json';
const CACHE_TTL = 3 * 24 * 3600 * 1000;
const bsCache = await loadJson(CACHE_FILE, {});
let saveTimer = null;
const scheduleSave = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJson(CACHE_FILE, bsCache).catch(console.error), 2000);
};

// File d'attente pour rester gentil avec l'API BeatSaver.
const MAX_CONCURRENT = 3;
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= MAX_CONCURRENT) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const compactMap = d => {
  const v = d.versions?.[0] || {};
  const diffs = v.diffs || [];
  return {
    id: d.id,
    songName: d.metadata.songName,
    songSubName: d.metadata.songSubName,
    songAuthorName: d.metadata.songAuthorName,
    mapper: d.metadata.levelAuthorName || d.uploader?.name,
    bpm: Math.round(d.metadata.bpm),
    duration: d.metadata.duration,
    upvotes: d.stats.upvotes,
    downvotes: d.stats.downvotes,
    score: d.stats.score,
    curated: !!d.curatedAt,
    ranked: !!(d.ranked || d.blRanked),
    uploaded: d.uploaded,
    cover: v.coverURL,
    preview: v.previewURL,
    download: v.downloadURL,
    difficulties: [...new Set(diffs.map(x => x.difficulty))],
    mods: {
      chroma: diffs.some(x => x.chroma),
      noodle: diffs.some(x => x.ne),
      mappingExtensions: diffs.some(x => x.me),
    },
  };
};

async function searchBeatSaver(query) {
  const hit = bsCache[query];
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.maps;

  const maps = await limited(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = `https://api.beatsaver.com/search/text/0?sortOrder=Relevance&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'beatsaber-plex-maps/1.0' } });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`BeatSaver ${res.status}`);
      return ((await res.json()).docs || []).map(compactMap);
    }
    throw new Error('BeatSaver : trop de requêtes');
  });
  bsCache[query] = { at: Date.now(), maps };
  scheduleSave();
  return maps;
}

async function mapsFor(track) {
  const query = searchQuery(track);
  if (!query) return [];
  const maps = await searchBeatSaver(query);
  return maps
    .filter(m => matches(track, mapHay(m)))
    .map(m => ({ ...m, installed: installed.keys.has(m.id) }));
}

// ---------- Sons masqués ----------

const HIDDEN_FILE = 'data/hidden.json';
const hidden = await loadJson(HIDDEN_FILE, {}); // ratingKey → "Artiste - Titre"

// ---------- API ----------

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

app.get('/api/tracks', wrap(async (req, res) => {
  const source = req.query.source || 'favorites';
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
  if (!installed) await scanInstalled();
  const tracks = (await getTracks(source, limit)).map(t => {
    const inst = installedFor(t);
    return { ...t, hidden: !!hidden[t.key], installedMaps: inst.map(m => ({ key: m.key, name: m.name })) };
  });
  res.json({ tracks, installedCount: installed.maps.length });
}));

app.post('/api/tracks/maps', wrap(async (req, res) => {
  const { title, artist } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title requis' });
  if (!installed) await scanInstalled();
  res.json({ maps: await mapsFor({ title, artist }) });
}));

app.post('/api/rescan', wrap(async (req, res) => {
  const r = await scanInstalled();
  res.json({ installedCount: r.maps.length });
}));

app.get('/api/hidden', (req, res) => res.json(hidden));
app.post('/api/hidden', wrap(async (req, res) => {
  const { key, label, hide } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key requis' });
  if (hide) hidden[key] = label || key; else delete hidden[key];
  await saveJson(HIDDEN_FILE, hidden);
  res.json({ ok: true });
}));

// Pochettes Plex via le serveur, pour ne pas exposer le token au navigateur.
app.get('/api/thumb', wrap(async (req, res) => {
  const p = String(req.query.p || '');
  if (!p.startsWith('/library/')) return res.status(400).end();
  const url = new URL('/photo/:/transcode', PLEX_URL);
  url.search = new URLSearchParams({ width: 160, height: 160, minSize: 1, url: p }).toString();
  const r = await fetch(url, { headers: { 'X-Plex-Token': PLEX_TOKEN } });
  if (!r.ok) return res.status(r.status).end();
  res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(Buffer.from(await r.arrayBuffer()));
}));

app.listen(PORT, () => console.log(`BeatSaber × Plex → http://localhost:${PORT}`));
