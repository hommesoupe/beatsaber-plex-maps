// Normalisation et correspondance artiste/titre entre Plex, BeatSaver et les maps installées.

export function norm(s = '', { keepBrackets = false } = {}) {
  let out = String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!keepBrackets) out = out.replace(/\(.*?\)|\[.*?\]|\{.*?\}|【.*?】/g, ' ');
  out = out
    .replace(/\s(feat|ft|featuring)\.?\s.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}

// Titre normalisé, en gardant les parenthèses si le titre n'est que ça.
export function normTitle(title) {
  return norm(title) || norm(title, { keepBrackets: true });
}

// Un morceau peut avoir plusieurs artistes : "A, B", "A & B", "A feat. B", "A x B".
export function artistParts(artist = '') {
  const raw = String(artist).split(/\s*(?:,|;|\/|&|\bfeat\.?|\bft\.?|\bx\b|\bvs\.?)\s*/i);
  const parts = [artist, ...raw]
    .map(a => norm(a).replace(/^the /, ''))
    .filter(a => a.length > 0);
  return [...new Set(parts)];
}

const phraseIn = (needle, hay) => needle && ` ${hay} `.includes(` ${needle} `);

// hay : texte normalisé contenant auteur + nom de la chanson de la map.
export function matches(track, hay) {
  const title = normTitle(track.title);
  if (!title || !phraseIn(title, hay)) return false;
  return artistParts(track.artist).some(a => phraseIn(a, hay));
}

export function mapHay({ songName = '', songSubName = '', songAuthorName = '' }) {
  return [songAuthorName, songName, songSubName].map(x => norm(x, { keepBrackets: true })).join(' ');
}

export function searchQuery(track) {
  const artist = artistParts(track.artist)[1] || artistParts(track.artist)[0] || '';
  return `${artist} ${normTitle(track.title)}`.trim();
}
