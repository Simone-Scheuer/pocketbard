# PocketBard

Fantasy tavern backing-track generator. Procedural Web Audio engine (sampled
percussion + physical-modeling synthesis fallback) with a performance surface
for playing along on tin whistle or harp.

**Live:** https://simone-scheuer.github.io/pocketbard/ — deploy with `./deploy.sh`.
Repo: https://github.com/Simone-Scheuer/pocketbard

## Development

```
npm install
npm run dev              # http://localhost:5173
npm run build            # dist/      — PWA build (installable, offline shell)
npm run build:artifact   # dist-one/  — single self-contained HTML
                         #              (published to the claude.ai artifact link;
                         #               no samples ship in this mode, the engine
                         #               falls back to synthesis)
```

## Architecture

```
src/
  util.js      helpers
  theory.js    notes, modes, chords, whistle-fit hint
  styles.js    tunes as pure data (patterns in a step DSL) + validation
  state.js     persisted user state (localStorage)
  samples.js   SampleLibrary: manifest-driven one-shots & chromatic notes,
               lead-silence trim + normalization, round-robin
  engine.js    audio core, conductor (live intensity), instruments
               (sample-first, synthesis fallback), generators, sequencer
  ui.js        all DOM
  main.js      boot + service-worker registration
public/
  samples/     CC0 audio (see samples/LICENSE.md) + manifest.json
  sw.js        stale-while-revalidate service worker
  manifest.webmanifest, icons/
```

Design doctrines (learned from user feedback, do not regress):
- Repetition is the accompanist's job: patterns commit per 4-bar section;
  the tss is deterministic; variation lives at section edges and fills.
- Rowdy = harder, not busier. No breakbeat drum chatter.
- Physical plausibility lives in instruments (re-strike gates), not patterns.
- Instruments are roster data; new sounds are definitions, not plumbing.

## Deploying as a real PWA

Any static host works: `npm run build`, upload `dist/`. For the installable
app experience on a phone, serve over HTTPS and "Add to Home Screen".

## Adding samples

Drop files under `public/samples/`, list them in `manifest.json`
(`hits` for percussion articulations, `notes` for pitched instruments,
`gains` for musical level). Instruments pick them up automatically and
synthesize anything unmapped. See `out/2026_07_14_tavern_sound_research.md`
for vetted CC0 sources for the next instruments (lute, harp, bass).
