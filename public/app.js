const $ = s => document.querySelector(s);
const list = $('#list');
const player = $('#player');

const state = {
  source: 'favorites',
  tracks: [],
  maps: new Map(),     // track.key → maps[] | 'loading' | 'error'
  expanded: new Set(), // track.key dont toutes les maps sont affichées
  installedCount: 0,
  playing: null,
  generation: 0,
};

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('bsplex-prefs')) || {}; } catch { return {}; }
})();
const savePrefs = () => {
  try { localStorage.setItem('bsplex-prefs', JSON.stringify(prefs)); } catch { /* ignoré */ }
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDuration = s => s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '';
const DIFF_SHORT = { Easy: 'E', Normal: 'N', Hard: 'H', Expert: 'Ex', ExpertPlus: 'E+' };

async function api(url, body) {
  const res = await fetch(url, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- Chargement ----------

async function loadTracks() {
  const gen = ++state.generation;
  state.tracks = [];
  state.maps.clear();
  state.expanded.clear();
  render();
  $('#stats').textContent = 'Lecture de Plex…';
  try {
    const { tracks, installedCount } = await api(`/api/tracks?source=${state.source}&limit=${$('#limit').value}`);
    if (gen !== state.generation) return;
    state.tracks = tracks;
    state.installedCount = installedCount;
    render();
    fetchNeededMaps();
  } catch (e) {
    $('#stats').textContent = `Erreur : ${e.message}`;
  }
}

const queue = [];
let running = 0;
function fetchNeededMaps() {
  for (const t of state.tracks) {
    if (state.maps.has(t.key) || !isCandidate(t, { ignoreEmpty: true })) continue;
    state.maps.set(t.key, 'loading');
    queue.push({ t, gen: state.generation });
  }
  pump();
}
function pump() {
  while (running < 4 && queue.length) {
    const { t, gen } = queue.shift();
    if (gen !== state.generation) continue;
    running++;
    api('/api/tracks/maps', { title: t.title, artist: t.artist })
      .then(r => { if (gen === state.generation) state.maps.set(t.key, r.maps); })
      .catch(() => { if (gen === state.generation) state.maps.set(t.key, 'error'); })
      .finally(() => { running--; scheduleRender(); pump(); });
  }
}

// ---------- Filtrage / tri ----------

function isCandidate(t, { ignoreEmpty = false } = {}) {
  if (t.hidden && !$('#showHidden').checked) return false;
  if (t.installedMaps.length && !$('#showInstalled').checked) return false;
  if (!ignoreEmpty && !$('#showEmpty').checked) {
    const m = state.maps.get(t.key);
    if (Array.isArray(m) && m.length === 0) return false;
    if (m === 'error') return false;
  }
  return true;
}

function sortMaps(maps) {
  const by = $('#mapSort').value;
  const key = {
    upvotes: m => m.upvotes,
    score: m => m.score,
    recent: m => Date.parse(m.uploaded) || 0,
  }[by];
  return [...maps].sort((a, b) => key(b) - key(a));
}

function visibleTracks() {
  const tracks = state.tracks.filter(t => isCandidate(t));
  if ($('#trackSort').value === 'best') {
    const best = t => {
      const m = state.maps.get(t.key);
      return Array.isArray(m) && m.length ? Math.max(...m.map(x => x.upvotes)) : -1;
    };
    tracks.sort((a, b) => best(b) - best(a));
  }
  return tracks;
}

// ---------- Rendu ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const tracks = visibleTracks();
  const total = state.tracks.length;
  const installed = state.tracks.filter(t => t.installedMaps.length).length;
  const pending = [...state.maps.values()].filter(v => v === 'loading').length;
  const searched = [...state.maps.values()].filter(v => v !== 'loading').length;
  const withMaps = state.tracks.filter(t => {
    const m = state.maps.get(t.key);
    return Array.isArray(m) && m.some(x => !x.installed);
  }).length;

  if (total) {
    $('#stats').innerHTML = `<b>${total}</b> sons Plex · <b>${installed}</b> déjà installés dans BSManager (${state.installedCount} maps) · `
      + `<b>${withMaps}</b> avec des maps à découvrir`
      + (pending ? ` · recherche BeatSaver ${searched}/${searched + pending}…` : '');
  }
  $('#bar').style.width = pending ? `${(searched / (searched + pending)) * 100}%` : '0';

  if (!tracks.length) {
    cards.clear();
    list.innerHTML = total ? '<div class="empty">Rien à afficher avec ces filtres.</div>' : '';
    return;
  }

  // Ne recrée que les cartes qui ont changé, pour éviter que les pochettes clignotent.
  const next = new Map();
  const els = tracks.map(t => {
    const html = renderTrack(t);
    let card = cards.get(t.key);
    if (!card || card.html !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      card = { html, el: tpl.content.firstElementChild };
    }
    next.set(t.key, card);
    return card.el;
  });
  cards = next;
  if (list.firstElementChild?.classList.contains('empty')) list.innerHTML = '';
  els.forEach((el, i) => {
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  while (list.children.length > els.length) list.lastElementChild.remove();
}
let cards = new Map(); // track.key → { html, el }

function renderTrack(t) {
  const maps = state.maps.get(t.key);
  const stars = t.rating ? `<span class="stars">${'★'.repeat(Math.round(t.rating / 2))}</span>` : '';
  const thumb = t.thumb
    ? `<img loading="lazy" src="/api/thumb?p=${encodeURIComponent(t.thumb)}" alt="">`
    : '<div class="noimg"></div>';

  let status = '';
  if (t.installedMaps.length) status = `<span class="pill ok" title="${esc(t.installedMaps.map(m => m.name).join('\n'))}">✓ déjà dans BSManager</span>`;
  else if (Array.isArray(maps)) status = maps.length ? `<span class="pill">${maps.length} map${maps.length > 1 ? 's' : ''}</span>` : '<span class="pill none">aucune map</span>';

  let body = '';
  if (maps === 'loading' || maps === undefined) body = '<div class="loading">Recherche sur BeatSaver…</div>';
  else if (maps === 'error') body = '<div class="loading">Erreur BeatSaver — réessaie plus tard.</div>';
  else if (maps.length) {
    const sorted = sortMaps(maps);
    const shown = state.expanded.has(t.key) ? sorted : sorted.slice(0, 3);
    body = `<div class="maps">${shown.map(renderMap).join('')}</div>`;
    if (sorted.length > 3) {
      body += `<div class="more"><button data-act="expand" data-key="${t.key}">${state.expanded.has(t.key) ? 'Réduire' : `Voir les ${sorted.length - 3} autres maps`}</button></div>`;
    }
  }

  return `
    <article class="track ${t.hidden ? 'dim' : ''}">
      <div class="track-head">
        ${thumb}
        <div class="track-info">
          <div class="track-title">${esc(t.title)}</div>
          <div class="track-artist">${esc(t.artist)}${t.album ? ` · ${esc(t.album)}` : ''}</div>
          <div class="track-meta">${stars}${t.plays ? `<span>▶ ${t.plays} écoute${t.plays > 1 ? 's' : ''}</span>` : ''}${status}</div>
        </div>
        <div class="track-actions">
          <button class="btn" data-act="hide" data-key="${t.key}">${t.hidden ? 'Réafficher' : 'Pas intéressé'}</button>
        </div>
      </div>
      ${body}
    </article>`;
}

function renderMap(m) {
  const diffs = m.difficulties
    .sort((a, b) => Object.keys(DIFF_SHORT).indexOf(a) - Object.keys(DIFF_SHORT).indexOf(b))
    .map(d => `<span class="diff d-${d}" title="${d}">${DIFF_SHORT[d] || d[0]}</span>`).join('');
  const badges = [
    m.installed && '<span class="badge have">installée</span>',
    m.curated && '<span class="badge curated">curated</span>',
    m.ranked && '<span class="badge ranked">ranked</span>',
    m.mods.noodle && '<span class="badge mod">noodle</span>',
    m.mods.chroma && '<span class="badge mod">chroma</span>',
  ].filter(Boolean).join('');
  const playing = state.playing === m.id;

  return `
    <div class="map">
      <img loading="lazy" src="${esc(m.cover)}" alt="">
      <div style="min-width:0">
        <div class="map-name">${esc(m.songAuthorName)} - ${esc(m.songName)} <small>par ${esc(m.mapper)}</small></div>
        <div class="map-meta">
          <span class="score">${Math.round(m.score * 100)}%</span>
          <span class="up">▲ ${m.upvotes}</span><span class="down">▼ ${m.downvotes}</span>
          <span class="diffs">${diffs}</span>
          <span>${fmtDuration(m.duration)} · ${m.bpm} BPM</span>
          ${badges}
        </div>
      </div>
      <div class="map-actions">
        <button class="btn ${playing ? 'playing' : ''}" data-act="preview" data-id="${m.id}" data-src="${esc(m.preview)}">${playing ? '■' : '▶'}</button>
        <a class="btn" href="https://beatsaver.com/maps/${m.id}" target="_blank" rel="noopener">BeatSaver</a>
        <a class="btn primary" href="beatsaver://${m.id}" title="Installation en un clic (BSManager / ModAssistant)">Installer</a>
      </div>
    </div>`;
}

// ---------- Événements ----------

list.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, key } = el.dataset;

  if (act === 'expand') {
    state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
    render();
  } else if (act === 'hide') {
    const t = state.tracks.find(x => x.key === key);
    t.hidden = !t.hidden;
    render();
    await api('/api/hidden', { key, label: `${t.artist} - ${t.title}`, hide: t.hidden });
  } else if (act === 'preview') {
    if (state.playing === el.dataset.id) {
      player.pause();
      state.playing = null;
    } else {
      player.src = el.dataset.src;
      player.volume = 0.6;
      player.play();
      state.playing = el.dataset.id;
    }
    render();
  }
});
player.addEventListener('ended', () => { state.playing = null; render(); });

$('#source').addEventListener('click', e => {
  const b = e.target.closest('button[data-source]');
  if (!b || b.dataset.source === state.source) return;
  document.querySelectorAll('#source button').forEach(x => x.classList.toggle('active', x === b));
  state.source = prefs.source = b.dataset.source;
  savePrefs();
  loadTracks();
});

for (const id of ['showInstalled', 'showEmpty', 'showHidden', 'mapSort', 'trackSort']) {
  const el = $(`#${id}`);
  if (id in prefs) el.type === 'checkbox' ? (el.checked = prefs[id]) : (el.value = prefs[id]);
  el.addEventListener('change', () => {
    prefs[id] = el.type === 'checkbox' ? el.checked : el.value;
    savePrefs();
    fetchNeededMaps();
    render();
  });
}
if (prefs.limit) $('#limit').value = prefs.limit;
$('#limit').addEventListener('change', () => { prefs.limit = $('#limit').value; savePrefs(); loadTracks(); });

$('#rescan').addEventListener('click', async () => {
  $('#rescan').disabled = true;
  try { await api('/api/rescan', {}); await loadTracks(); } finally { $('#rescan').disabled = false; }
});

if (prefs.source) {
  state.source = prefs.source;
  document.querySelectorAll('#source button').forEach(x => x.classList.toggle('active', x.dataset.source === state.source));
}
loadTracks();
