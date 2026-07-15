/* The Forge — build your own tune. Produces a full style object the engine
   plays like any built-in. Forge tunes use "plain form": your parts play in
   your order, every instrument on, looping — no hidden intro/hush/tag arc, so
   what you build is exactly what you hear. */
import {$, clamp} from './util.js';
import {NOTE_NAMES, MODES} from './theory.js';
import {STYLES, registerSong, unregisterSong} from './styles.js';
import {state, persist} from './state.js';
import * as engine from './engine.js';

const METERS = [['2/4', 2, 4], ['3/4', 3, 4], ['4/4', 4, 4], ['6/8', 2, 6], ['9/8', 3, 6]];
const MODE_LIST = [['dorian', 'Dorian'], ['major', 'Major'], ['mixolydian', 'Mixolydian'],
  ['aeolian', 'Minor'], ['phrygian', 'Phrygian'], ['hijaz', 'Hijaz']];

/* ---- pattern synthesis: valid-length strings from a density 1..3 ---- */
function mkDrum(m, dens) {
  const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.');
  a[0] = 'D';
  if (B >= 2) a[Math.round(B / 2) * S] = 'D';
  if (dens >= 2) for (let b = 0; b < B; b++) a[b * S] = 'D';
  if (dens >= 2) for (let b = 0; b < B; b++) { const i = b * S + Math.floor(S / 2); if (a[i] === '.') a[i] = 't'; }
  if (dens >= 3) for (let b = 0; b < B; b++) for (let k = 1; k < S; k += 2) { const i = b * S + k; if (a[i] === '.') a[i] = 't'; }
  return a.join('');
}
function mkHarm(m, dens) {
  const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.');
  a[0] = 'C';
  if (dens >= 2) for (let b = 0; b < B; b++) a[b * S] = b % 2 ? 'c' : 'C';
  if (dens >= 3) for (let b = 0; b < B; b++) { const i = b * S + Math.floor(S / 2); if (a[i] === '.') a[i] = 'c'; }
  return a.join('');
}
function mkBass(m, dens) {
  const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.');
  a[0] = 'R';
  if (dens >= 2 && B >= 2) a[Math.round(B / 2) * S] = '5';
  if (dens >= 3) for (let b = 0; b < B; b++) if (a[b * S] === '.') a[b * S] = b % 2 ? '5' : 'R';
  return a.join('');
}
function mkJingle(m, dens) {
  const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.');
  const spots = B >= 4 ? [1, 3] : B >= 2 ? [1] : [0];
  for (const b of spots) if (b < B) a[b * S] = 'X';
  if (dens >= 3) for (let b = 0; b < B; b++) { const i = b * S + Math.floor(S / 2); if (a[i] === '.') a[i] = 'x'; }
  return a.join('');
}
const threePat = (mk, m, d) => ({
  calm: [{s: mk(m, clamp(d - 1, 1, 3)), w: 1}],
  lively: [{s: mk(m, d), w: 1}],
  rowdy: [{s: mk(m, clamp(d + 1, 1, 3)), w: 1}],
});

/* ---- roles: how a UI choice becomes an engine part ---- */
const ROLES = [
  {key: 'melody', label: 'Melody', insts: ['harp', 'lute', 'oud'],
    build: r => ({kind: 'gen', inst: r.inst, gen: 'melody', base: 60, density: [.4, .7, 1][r.dens - 1]})},
  {key: 'harmony', label: 'Harmony', insts: ['lute', 'harp', 'oud'],
    build: (r, m) => ({kind: 'harmony', inst: r.inst, pat: threePat(mkHarm, m, r.dens)})},
  {key: 'bass', label: 'Bass', insts: ['bassViol'],
    build: (r, m) => ({kind: 'bass', inst: 'bassViol', pat: threePat(mkBass, m, r.dens)})},
  {key: 'drum', label: 'Drum', insts: ['bodhran', 'darbuka'],
    build: (r, m) => ({kind: 'drum', map: r.inst === 'darbuka' ? 'darbuka' : 'celtic', pat: threePat(mkDrum, m, r.dens)})},
  {key: 'texture', label: 'Pitter-patter', insts: ['bongos'],
    build: r => ({kind: 'gen', inst: 'bongos', gen: 'fingerTexture', density: [.3, .5, .75][r.dens - 1]})},
  {key: 'jingle', label: 'Jingle', insts: ['tambourine', 'riq', 'silver'],
    build: (r, m) => r.inst === 'silver'
      ? {kind: 'gen', inst: 'silver', gen: 'backbeatTss'}
      : {kind: 'jingle', inst: r.inst, pat: threePat(mkJingle, m, r.dens)}},
  {key: 'fiddle', label: 'Fiddle', insts: ['fiddle'],
    build: r => ({kind: 'gen', inst: 'fiddle', gen: 'fiddleLine'})},
  {key: 'accordion', label: 'Accordion', insts: ['accordion'],
    build: r => ({kind: 'gen', inst: 'accordion', gen: 'squeeze'})},
];
const INST_LABEL = {harp: 'Harp', lute: 'Lute', oud: 'Oud', bassViol: 'Bass', bodhran: 'Bodhrán',
  darbuka: 'Darbuka', bongos: 'Bongos', tambourine: 'Tambourine', riq: 'Riq', silver: 'Shimmer',
  fiddle: 'Fiddle', accordion: 'Accordion'};

/* ---- the draft ---- */
let draft = null;
let activeSec = 'A';
let selChord = -1; /* -1 = append mode; >=0 = a selected chord being edited */

function starterProg(mode) {
  return mode === 'major' || mode === 'mixolydian'
    ? [{d: 0, q: 'M'}, {d: 3, q: 'M'}, {d: 4, q: 'M'}, {d: 0, q: 'M'}]
    : [{d: 0, q: 'm'}, {d: 3, q: 'M'}, {d: 6, q: 'M'}, {d: 0, q: 'm'}];
}
function newDraft() {
  return {
    id: '__draft', _user: true, plain: true, name: 'My Tune', icon: '🎵',
    mode: 'dorian', tonic: 2, bpm: 104, beatsPerBar: 4, stepsPerBeat: 4,
    swing: 0, lilt: 0, reverb: .16, drone: .4, pad: 0,
    sections: {A: starterProg('dorian')},
    order: ['A'], form: 'AABB',
    _roles: {
      melody: {on: true, inst: 'harp', dens: 2},
      harmony: {on: false, inst: 'lute', dens: 2},
      bass: {on: true, inst: 'bassViol', dens: 2},
      drum: {on: true, inst: 'bodhran', dens: 2},
      texture: {on: false, inst: 'bongos', dens: 2},
      jingle: {on: false, inst: 'tambourine', dens: 2},
      fiddle: {on: true, inst: 'fiddle', dens: 2},
      accordion: {on: false, inst: 'accordion', dens: 2},
    },
    parts: {},
  };
}

/* rebuild engine-facing parts from role settings and register the draft */
function commit() {
  draft.parts = {};
  for (const role of ROLES) { const r = draft._roles[role.key]; if (r.on) draft.parts[role.key] = role.build(r, draft); }
  registerSong(draft);
}

/* diatonic chords for the current mode */
function palette() {
  const iv = MODES[draft.mode].iv, N = iv.length, out = [];
  for (let d = 0; d < N; d++) {
    const third = (((iv[(d + 2) % N] - iv[d]) % 12) + 12) % 12;
    out.push({d, q: third === 4 ? 'M' : 'm'});
  }
  return out;
}
function chordName(d, q) {
  const iv = MODES[draft.mode].iv, N = iv.length;
  const pc = (draft.tonic + iv[d % N] + (d >= N ? 12 : 0)) % 12;
  return NOTE_NAMES[pc] + (q === 'm' ? 'm' : q === '5' ? '5' : '');
}

/* ================= UI ================= */
export function initForge() {
  draft = newDraft();
  buildFoundation();
  buildBand();
  $('#fgName').addEventListener('input', e => { draft.name = e.target.value.slice(0, 28); });
  $('#fgSave').addEventListener('click', saveSong);
  $('#fgPreview').addEventListener('click', preview);
  $('#fgClearPart').addEventListener('click', () => { draft.sections[activeSec] = starterProg(draft.mode); selChord = -1; commit(); refreshProg(); });
  engine.on('forge-now', showNow);
  commit();
  buildPartTabs();
  buildPalette();
  refreshProg();
  buildOrder();
}

function seg(container, items, active, onPick) {
  const wrap = $(container); wrap.textContent = '';
  for (const [val, label] of items) {
    const b = document.createElement('button');
    b.className = 'fgOpt'; b.textContent = label;
    b.setAttribute('aria-pressed', String(val === active()));
    b.addEventListener('click', () => { onPick(val); for (const o of wrap.children) o.setAttribute('aria-pressed', String(o === b)); });
    wrap.appendChild(b);
  }
}

function buildFoundation() {
  seg('#fgMeter', METERS.map(m => [m[0], m[0]]), () => draft.beatsPerBar + '/' + (draft.stepsPerBeat === 6 ? 8 : 4),
    v => { const m = METERS.find(x => x[0] === v); draft.beatsPerBar = m[1]; draft.stepsPerBeat = m[2];
      draft.lilt = m[2] === 6 ? .06 : 0; draft.swing = 0; commit(); });
  seg('#fgMode', MODE_LIST, () => draft.mode, v => { draft.mode = v; commit(); buildPalette(); refreshProg(); });
  const keyWrap = $('#fgKey'); keyWrap.textContent = '';
  NOTE_NAMES.forEach((n, pc) => {
    const b = document.createElement('button'); b.className = 'fgKeyBtn'; b.textContent = n;
    b.setAttribute('aria-pressed', String(pc === draft.tonic));
    b.addEventListener('click', () => { draft.tonic = pc; for (const o of keyWrap.children) o.setAttribute('aria-pressed', String(o === b));
      commit(); buildPalette(); refreshProg(); });
    keyWrap.appendChild(b);
  });
  $('#fgTempo').addEventListener('input', e => { draft.bpm = +e.target.value; $('#fgTempoOut').textContent = e.target.value; });
  $('#fgTempo').value = draft.bpm; $('#fgTempoOut').textContent = draft.bpm;
  $('#fgDrone').addEventListener('input', e => { draft.drone = +e.target.value / 100; commit(); });
  $('#fgDrone').value = Math.round(draft.drone * 100);
}

/* ---- parts (sections) ---- */
function buildPartTabs() {
  const wrap = $('#fgSecTabs'); wrap.textContent = '';
  for (const name of Object.keys(draft.sections)) {
    const b = document.createElement('button'); b.className = 'fgSecTab'; b.textContent = name;
    b.setAttribute('aria-pressed', String(name === activeSec));
    b.addEventListener('click', () => { activeSec = name; selChord = -1; buildPartTabs(); refreshProg(); });
    wrap.appendChild(b);
  }
  if (Object.keys(draft.sections).length < 4) {
    const add = document.createElement('button'); add.className = 'fgSecTab fgAdd'; add.textContent = '+';
    add.title = 'Add a part';
    add.addEventListener('click', () => {
      const next = ['A', 'B', 'C', 'D'].find(n => !(n in draft.sections));
      draft.sections[next] = starterProg(draft.mode);
      draft.order.push(next);
      activeSec = next; selChord = -1; commit(); buildPartTabs(); refreshProg(); buildOrder();
    });
    wrap.appendChild(add);
  }
}

/* ---- chord progression (chips) ---- */
function refreshProg() {
  const wrap = $('#fgProg'); if (!wrap) return; wrap.textContent = '';
  const bars = draft.sections[activeSec] || [];
  bars.forEach((spec, i) => {
    const chip = document.createElement('button');
    chip.className = 'fgChip' + (i === selChord ? ' sel' : '');
    chip.dataset.i = i;
    chip.innerHTML = '<span class="fgChipC">' + chordName(spec.d, spec.q) + '</span>' +
      (i === selChord ? '<span class="fgChipX" role="button" aria-label="remove chord">✕</span>' : '');
    chip.addEventListener('click', e => {
      if (e.target.classList.contains('fgChipX')) { removeChord(i); return; }
      selChord = (selChord === i) ? -1 : i; refreshProg();
    });
    wrap.appendChild(chip);
  });
  $('#fgBarInfo').textContent = selChord >= 0
    ? 'editing chord ' + (selChord + 1) + ' — tap a chord below to change it'
    : bars.length + ' chord' + (bars.length === 1 ? '' : 's') + ' — tap a chord below to add';
}
function removeChord(i) {
  const bars = draft.sections[activeSec];
  if (bars.length <= 1) return;
  bars.splice(i, 1); selChord = -1; commit(); refreshProg();
}
function placeChord(d, q) {
  const bars = draft.sections[activeSec];
  if (selChord >= 0 && selChord < bars.length) { bars[selChord] = {d, q}; }
  else if (bars.length < 16) { bars.push({d, q}); }
  commit(); refreshProg();
}

function buildPalette() {
  const wrap = $('#fgPalette'); if (!wrap) return; wrap.textContent = '';
  for (const c of palette()) {
    const b = document.createElement('button'); b.className = 'fgChord'; b.textContent = chordName(c.d, c.q);
    b.addEventListener('click', () => placeChord(c.d, c.q));
    wrap.appendChild(b);
  }
  const fifth = document.createElement('button'); fifth.className = 'fgChord fgFifth';
  fifth.textContent = 'open 5th'; fifth.title = 'make the selected chord an open fifth (no third)';
  fifth.addEventListener('click', () => { const b = draft.sections[activeSec][selChord]; if (b) { b.q = '5'; commit(); refreshProg(); } });
  wrap.appendChild(fifth);
}

/* ---- play order (arrangement) ---- */
function buildOrder() {
  const wrap = $('#fgOrder'); if (!wrap) return; wrap.textContent = '';
  draft.order.forEach((name, i) => {
    const chip = document.createElement('button'); chip.className = 'fgOrderChip'; chip.textContent = name;
    chip.title = 'tap to remove from the order';
    chip.addEventListener('click', () => { if (draft.order.length > 1) { draft.order.splice(i, 1); commit(); buildOrder(); } });
    wrap.appendChild(chip);
    const arrow = document.createElement('span'); arrow.className = 'fgArrow'; arrow.textContent = '→';
    wrap.appendChild(arrow);
  });
  const loop = document.createElement('span'); loop.className = 'fgArrow'; loop.textContent = '↻';
  wrap.appendChild(loop);
  /* add-a-part buttons */
  for (const name of Object.keys(draft.sections)) {
    const add = document.createElement('button'); add.className = 'fgOrderAdd'; add.textContent = '+' + name;
    add.title = 'add part ' + name + ' to the order';
    add.addEventListener('click', () => { draft.order.push(name); commit(); buildOrder(); });
    wrap.appendChild(add);
  }
}

/* ---- now-playing highlight during preview ---- */
function showNow({part, bar}) {
  if (state.styleId !== '__draft') return;
  const fv = $('#viewForge'); if (!fv || !fv.classList.contains('active')) return;
  for (const t of document.querySelectorAll('#fgSecTabs .fgSecTab')) t.classList.toggle('now', t.textContent === part);
  for (const c of document.querySelectorAll('#fgProg .fgChip')) c.classList.toggle('now', part === activeSec && +c.dataset.i === bar);
  for (const o of document.querySelectorAll('#fgOrder .fgOrderChip')) o.classList.toggle('now', o.textContent === part);
}
function clearNow() {
  for (const el of document.querySelectorAll('.fgSecTab.now, .fgChip.now, .fgOrderChip.now')) el.classList.remove('now');
}

/* ---- band ---- */
function buildBand() {
  const wrap = $('#fgBand'); wrap.textContent = '';
  for (const role of ROLES) {
    const r = draft._roles[role.key];
    const row = document.createElement('div'); row.className = 'fgRole';
    const tog = document.createElement('button'); tog.className = 'fgRoleTog'; tog.textContent = role.label;
    tog.setAttribute('aria-pressed', String(r.on));
    tog.addEventListener('click', () => { r.on = !r.on; tog.setAttribute('aria-pressed', String(r.on)); row.classList.toggle('off', !r.on); commit(); });
    row.appendChild(tog);
    if (role.insts.length > 1) {
      const iw = document.createElement('div'); iw.className = 'fgInsts';
      for (const inst of role.insts) {
        const ib = document.createElement('button'); ib.className = 'fgInstOpt'; ib.textContent = INST_LABEL[inst] || inst;
        ib.setAttribute('aria-pressed', String(inst === r.inst));
        ib.addEventListener('click', () => { r.inst = inst; for (const o of iw.children) o.setAttribute('aria-pressed', String(o === ib)); commit(); });
        iw.appendChild(ib);
      }
      row.appendChild(iw);
    }
    if (role.key !== 'fiddle' && role.key !== 'accordion') {
      const dw = document.createElement('div'); dw.className = 'fgDens';
      ['·', '··', '···'].forEach((lab, i) => {
        const db = document.createElement('button'); db.className = 'fgDensOpt'; db.textContent = lab;
        db.title = ['sparse', 'medium', 'busy'][i];
        db.setAttribute('aria-pressed', String(r.dens === i + 1));
        db.addEventListener('click', () => { r.dens = i + 1; for (const o of dw.children) o.setAttribute('aria-pressed', String(o === db)); commit(); });
        dw.appendChild(db);
      });
      row.appendChild(dw);
    }
    row.classList.toggle('off', !r.on);
    wrap.appendChild(row);
  }
}

/* ---- transport / save ---- */
function preview() {
  commit();
  if (state.playing && state.styleId !== '__draft') { state.pending.styleId = '__draft'; state.pending.tonic = draft.tonic; }
  else if (state.playing) engine.togglePlay();
  else { state.styleId = '__draft'; state.tonic = draft.tonic; engine.togglePlay(); }
}
function saveSong() {
  const name = (draft.name || 'My Tune').slice(0, 28);
  const id = 'song_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const song = JSON.parse(JSON.stringify(draft));
  song.id = id; song.name = name; song._user = true; song.plain = true;
  registerSong(song);
  state.songs.push(song);
  if (state.songs.length > 40) { const drop = state.songs.shift(); unregisterSong(drop.id); }
  persist();
  document.dispatchEvent(new CustomEvent('forge-saved', {detail: {id}}));
  const b = $('#fgSave'); b.textContent = 'Saved ✓'; setTimeout(() => { b.textContent = 'Save to set list'; }, 1600);
}

export function forgeOnShow() {
  commit();
  $('#fgName').value = draft.name;
  refreshProg();
}
export function forgeTransport(playing) {
  const b = $('#fgPreview'); if (b) b.textContent = playing && state.styleId === '__draft' ? 'Stop preview' : 'Preview';
  if (!playing) clearNow();
}
