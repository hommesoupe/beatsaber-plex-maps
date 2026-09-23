# Beat Saber × Plex

Find Beat Saber maps for the music you actually listen to.

A small local web app that reads your Plex / Plexamp library, looks up each song on [BeatSaver](https://beatsaver.com), and shows the best maps — skipping songs you already have a map for in BSManager.

## How it works

1. **Pick a source** from Plex: your favorites (rated tracks), your most played, or your recent listening history.
2. **Skip what you already have**: installed maps are read from the BSManager shared maps folder (`Info.dat`), and any song with a matching artist + title is hidden.
3. **Search BeatSaver** for each remaining song, keep only real artist + title matches, and sort them by upvotes (or score / date).
4. **Install in one click** with `beatsaver://` links, preview the audio, or hide songs you don't care about.

## Setup

Requires Node 18+, a Plex server with a music library, and BSManager.

```bash
npm install
cp .env.example .env   # fill in PLEX_URL, PLEX_TOKEN, BS_MAPS_DIRS
npm start              # http://localhost:3100
```

| Variable | Description |
| --- | --- |
| `PLEX_URL` | Plex server URL |
| `PLEX_TOKEN` | Your [Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) |
| `PLEX_SECTION_ID` | Music library ID |
| `PLEX_ACCOUNT_ID` | Account used for listening history (`1` = server owner) |
| `BS_MAPS_DIRS` | Installed maps folder(s), `;`-separated |

BeatSaver results are cached for 3 days in `cache/`. Hidden songs are stored in `data/hidden.json`.

## Next steps

- [ ] Export the top picks as a Beat Saber playlist (`.bplist`) to install everything at once
- [ ] Artist view: every map from your favorite artists, not only rated tracks
- [ ] Filter maps by difficulty, duration or BPM
- [ ] Mark maps as installed right after clicking "Install" (without a rescan)
