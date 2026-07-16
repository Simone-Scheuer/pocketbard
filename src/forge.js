/* The Forge — a small arrangement view (DAW-lite). A chord timeline up top,
   instrument tracks below, an instrument shelf you drag from. Forge tunes use
   plain form: your parts play in your order, every track on, looping — what
   you build is what you hear. */
import {$, clamp} from './util.js';
import {NOTE_NAMES, MODES} from './theory.js';
import {STYLES, registerSong, unregisterSong} from './styles.js';
import {state, persist} from './state.js';
import * as engine from './engine.js';

const METERS = [['2/4', 2, 4], ['3/4', 3, 4], ['4/4', 4, 4], ['6/8', 2, 6], ['9/8', 3, 6]];
const MODE_LIST = [['dorian', 'Dorian'], ['major', 'Major'], ['mixolydian', 'Mixolydian'],
  ['aeolian', 'Minor'], ['phrygian', 'Phrygian'], ['hijaz', 'Hijaz']];
const Maj = (d) => ({d, q: 'M'}), Min = (d) => ({d, q: 'm'});
/* named starter progressions per mode (real trad shapes), one tap fills a part */
const PROGRESSIONS = {
  dorian: [['Wander', [Min(0), Maj(3), Maj(6), Min(0)]], ['Vamp', [Min(0), Maj(6), Min(0), Maj(6)]],
    ['Lift', [Min(0), Maj(2), Maj(3), Min(0)]], ['Rock', [Min(0), Maj(3), Min(0), Maj(3)]]],
  major: [['Trad', [Maj(0), Maj(3), Maj(4), Maj(0)]], ['Walk down', [Maj(0), Maj(4), Min(5), Maj(3)]],
    ['Courtly', [Maj(0), Maj(3), Maj(0), Maj(4)]], ['Homely', [Maj(0), Min(5), Maj(3), Maj(4)]]],
  mixolydian: [['Session', [Maj(0), Maj(6), Maj(3), Maj(0)]], ['Vamp', [Maj(0), Maj(6), Maj(0), Maj(6)]],
    ['Reel', [Maj(0), Maj(3), Maj(6), Maj(0)]]],
  aeolian: [['Lament', [Min(0), Maj(5), Maj(6), Min(0)]], ['Falling', [Min(0), Maj(6), Maj(5), Maj(6)]],
    ['Folk', [Min(0), Maj(2), Maj(6), Min(0)]]],
  phrygian: [['Dark', [Min(0), Maj(1), Min(0), Maj(1)]], ['Spanish', [Min(0), Maj(1), Maj(2), Maj(1)]]],
  hijaz: [['Desert', [Min(0), Maj(1), Min(0), Maj(1)]], ['Caravan', [Min(0), Maj(1), Maj(3), Min(0)]]],
};

/* ---- pattern synthesis from a busyness 1..3 ---- */
function mkDrum(m, d) { const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.'); a[0] = 'D';
  if (B >= 2) a[Math.round(B / 2) * S] = 'D';
  if (d >= 2) for (let b = 0; b < B; b++) a[b * S] = 'D';
  if (d >= 2) for (let b = 0; b < B; b++) { const i = b * S + Math.floor(S / 2); if (a[i] === '.') a[i] = 't'; }
  if (d >= 3) for (let b = 0; b < B; b++) for (let k = 1; k < S; k += 2) { const i = b * S + k; if (a[i] === '.') a[i] = 't'; }
  return a.join(''); }
function mkHarm(m, d) { const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.'); a[0] = 'C';
  if (d >= 2) for (let b = 0; b < B; b++) a[b * S] = b % 2 ? 'c' : 'C';
  if (d >= 3) for (let b = 0; b < B; b++) { const i = b * S + Math.floor(S / 2); if (a[i] === '.') a[i] = 'c'; }
  return a.join(''); }
function mkBass(m, d) { const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.'); a[0] = 'R';
  if (d >= 2 && B >= 2) a[Math.round(B / 2) * S] = '5';
  if (d >= 3) for (let b = 0; b < B; b++) if (a[b * S] === '.') a[b * S] = b % 2 ? '5' : 'R';
  return a.join(''); }
function mkJingle(m, d) { const B = m.beatsPerBar, S = m.stepsPerBeat, a = Array(B * S).fill('.');
  const spots = B >= 4 ? [1, 3] : B >= 2 ? [1] : [0];
  for (const b of spots) if (b < B) a[b * S] = 'X';
  if (d >= 3) for (let b = 0; b < B; b++) { const i = b * S + Math.floor(S / 2); if (a[i] === '.') a[i] = 'x'; }
  return a.join(''); }
const threePat = (mk, m, d) => ({calm: [{s: mk(m, clamp(d - 1, 1, 3)), w: 1}], lively: [{s: mk(m, d), w: 1}], rowdy: [{s: mk(m, clamp(d + 1, 1, 3)), w: 1}]});

/* ---- tracks (roles) ---- */
const ROLES = [
  {key: 'melody', label: 'Melody', icon: '🎵', insts: ['harp', 'lute', 'oud'], dens: true,
    build: r => ({kind: 'gen', inst: r.inst, gen: 'melody', base: 60, density: [.4, .7, 1][r.dens - 1]})},
  {key: 'harmony', label: 'Rhythm', icon: '🎶', insts: ['lute', 'harp', 'oud'], dens: true,
    build: (r, m) => ({kind: 'harmony', inst: r.inst, pat: threePat(mkHarm, m, r.dens)})},
  {key: 'bass', label: 'Bass', icon: '𝄢', insts: ['bassViol'], dens: true,
    build: (r, m) => ({kind: 'bass', inst: 'bassViol', pat: threePat(mkBass, m, r.dens)})},
  {key: 'drum', label: 'Drum', icon: '🥁', insts: ['bodhran', 'darbuka'], dens: true,
    build: (r, m) => ({kind: 'drum', map: r.inst === 'darbuka' ? 'darbuka' : 'celtic', pat: threePat(mkDrum, m, r.dens)})},
  {key: 'texture', label: 'Pitter-patter', icon: '👏', insts: ['bongos'], dens: true,
    build: r => ({kind: 'gen', inst: 'bongos', gen: 'fingerTexture', density: [.3, .5, .75][r.dens - 1]})},
  {key: 'jingle', label: 'Jingle', icon: '🔔', insts: ['tambourine', 'riq', 'silver'], dens: true,
    build: (r, m) => r.inst === 'silver' ? {kind: 'gen', inst: 'silver', gen: 'backbeatTss'}
      : {kind: 'jingle', inst: r.inst, pat: threePat(mkJingle, m, r.dens)}},
  {key: 'fiddle', label: 'Fiddle', icon: '🎻', insts: ['fiddle'], dens: false,
    build: r => ({kind: 'gen', inst: 'fiddle', gen: 'fiddleLine'})},
  {key: 'accordion', label: 'Accordion', icon: '🪗', insts: ['accordion'], dens: false,
    build: r => ({kind: 'gen', inst: 'accordion', gen: 'squeeze'})},
];
const ROLE = Object.fromEntries(ROLES.map(r => [r.key, r]));
const INST_LABEL = {harp: 'Harp', lute: 'Lute', oud: 'Oud', bassViol: 'Bass', bodhran: 'Bodhrán',
  darbuka: 'Darbuka', bongos: 'Bongos', tambourine: 'Tambourine', riq: 'Riq', silver: 'Shimmer', fiddle: 'Fiddle', accordion: 'Accordion'};

/* ---- draft state ---- */
let draft = null, activeSec = 'A', selChord = -1;
function starterProg(mode) {
  return mode === 'major' || mode === 'mixolydian'
    ? [{d: 0, q: 'M'}, {d: 3, q: 'M'}, {d: 4, q: 'M'}, {d: 0, q: 'M'}]
    : [{d: 0, q: 'm'}, {d: 3, q: 'M'}, {d: 6, q: 'M'}, {d: 0, q: 'm'}];
}
function newDraft() {
  return {id: '__draft', _user: true, plain: true, name: 'My Tune', icon: '🎵',
    mode: 'dorian', tonic: 2, bpm: 104, beatsPerBar: 4, stepsPerBeat: 4, swing: 0, lilt: 0, reverb: .16, drone: .4, pad: 0,
    sections: {A: starterProg('dorian')}, order: ['A'], form: 'AABB',
    _roles: {melody: {on: true, inst: 'harp', dens: 2}, harmony: {on: false, inst: 'lute', dens: 2},
      bass: {on: true, inst: 'bassViol', dens: 2}, drum: {on: true, inst: 'bodhran', dens: 2},
      texture: {on: false, inst: 'bongos', dens: 2}, jingle: {on: false, inst: 'tambourine', dens: 2},
      fiddle: {on: true, inst: 'fiddle', dens: 2}, accordion: {on: false, inst: 'accordion', dens: 2}},
    parts: {}};
}
function commit() {
  draft.parts = {};
  for (const role of ROLES) { const r = draft._roles[role.key]; if (r.on) draft.parts[role.key] = role.build(r, draft); }
  registerSong(draft);
}
function palette() {
  const iv = MODES[draft.mode].iv, N = iv.length, out = [];
  for (let d = 0; d < N; d++) { const third = (((iv[(d + 2) % N] - iv[d]) % 12) + 12) % 12; out.push({d, q: third === 4 ? 'M' : 'm'}); }
  return out;
}
function chordName(d, q) {
  const iv = MODES[draft.mode].iv, N = iv.length;
  const pc = (draft.tonic + iv[d % N] + (d >= N ? 12 : 0)) % 12;
  return NOTE_NAMES[pc] + (q === 'm' ? 'm' : q === '5' ? '5' : '');
}

/* ================= pointer drag (touch + mouse) ================= */
function makeDraggable(el, buildData, onDrop) {
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    const data = buildData(); if (!data) return;
    e.preventDefault();
    const ghost = el.cloneNode(true);
    ghost.classList.add('fgGhost');
    Object.assign(ghost.style, {position: 'fixed', left: e.clientX - 30 + 'px', top: e.clientY - 20 + 'px',
      pointerEvents: 'none', zIndex: 9999, opacity: '.9', width: el.offsetWidth + 'px'});
    document.body.appendChild(ghost);
    let curDrop = null;
    const move = ev => {
      ghost.style.left = ev.clientX - 30 + 'px'; ghost.style.top = ev.clientY - 20 + 'px';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const dz = under && under.closest('[data-drop]');
      if (dz !== curDrop) { if (curDrop) curDrop.classList.remove('fgDropOver'); curDrop = dz; if (dz) dz.classList.add('fgDropOver'); }
    };
    const up = ev => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      ghost.remove(); if (curDrop) curDrop.classList.remove('fgDropOver');
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const dz = under && under.closest('[data-drop]');
      onDrop(data, dz ? dz.dataset.drop : null, under);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}

/* ================= UI ================= */
export function initForge() {
  draft = newDraft();
  buildFoundation();
  $('#fgName').addEventListener('input', e => { draft.name = e.target.value.slice(0, 28); });
  $('#fgSave').addEventListener('click', saveSong);
  $('#fgPreview').addEventListener('click', preview);
  engine.on('forge-now', showNow);
  commit();
  buildPartTabs(); buildProgs(); buildRuler(); buildEditor(); buildOrder(); buildTracks(); buildShelf();
  updateFoundNow();
}

function seg(container, items, active, onPick) {
  const wrap = $(container); wrap.textContent = '';
  for (const [val, label] of items) {
    const b = document.createElement('button'); b.className = 'fgOpt'; b.textContent = label;
    b.setAttribute('aria-pressed', String(val === active()));
    b.addEventListener('click', () => { onPick(val); for (const o of wrap.children) o.setAttribute('aria-pressed', String(o === b)); });
    wrap.appendChild(b);
  }
}
function updateFoundNow() {
  const meter = draft.beatsPerBar + '/' + (draft.stepsPerBeat === 6 ? 8 : 4);
  $('#fgFoundNow').textContent = NOTE_NAMES[draft.tonic] + ' ' + MODES[draft.mode].label + ' · ' + meter + ' · ' + draft.bpm;
}
function buildFoundation() {
  seg('#fgMeter', METERS.map(m => [m[0], m[0]]), () => draft.beatsPerBar + '/' + (draft.stepsPerBeat === 6 ? 8 : 4),
    v => { const m = METERS.find(x => x[0] === v); draft.beatsPerBar = m[1]; draft.stepsPerBeat = m[2]; draft.lilt = m[2] === 6 ? .06 : 0; draft.swing = 0; commit(); updateFoundNow(); });
  seg('#fgMode', MODE_LIST, () => draft.mode, v => { draft.mode = v; commit(); buildProgs(); buildEditor(); buildRuler(); updateFoundNow(); });
  const keyWrap = $('#fgKey'); keyWrap.textContent = '';
  NOTE_NAMES.forEach((n, pc) => {
    const b = document.createElement('button'); b.className = 'fgKeyBtn'; b.textContent = n;
    b.setAttribute('aria-pressed', String(pc === draft.tonic));
    b.addEventListener('click', () => { draft.tonic = pc; for (const o of keyWrap.children) o.setAttribute('aria-pressed', String(o === b)); commit(); buildProgs(); buildEditor(); buildRuler(); updateFoundNow(); });
    keyWrap.appendChild(b);
  });
  $('#fgTempo').addEventListener('input', e => { draft.bpm = +e.target.value; $('#fgTempoOut').textContent = e.target.value; updateFoundNow(); });
  $('#fgTempo').value = draft.bpm; $('#fgTempoOut').textContent = draft.bpm;
  $('#fgDrone').addEventListener('input', e => { draft.drone = +e.target.value / 100; commit(); });
  $('#fgDrone').value = Math.round(draft.drone * 100);
}

/* ---- timeline: parts + chord ruler ---- */
function buildPartTabs() {
  const wrap = $('#fgParts'); wrap.textContent = '';
  for (const name of Object.keys(draft.sections)) {
    const b = document.createElement('button'); b.className = 'fgSecTab'; b.textContent = name; b.dataset.part = name;
    b.setAttribute('aria-pressed', String(name === activeSec));
    b.addEventListener('click', () => { activeSec = name; selChord = -1; buildPartTabs(); buildRuler(); buildEditor(); });
    wrap.appendChild(b);
  }
  if (Object.keys(draft.sections).length < 4) {
    const add = document.createElement('button'); add.className = 'fgSecTab fgAdd'; add.textContent = '+ part'; add.title = 'Add a part';
    add.addEventListener('click', () => {
      const next = ['A', 'B', 'C', 'D'].find(n => !(n in draft.sections));
      draft.sections[next] = starterProg(draft.mode); draft.order.push(next);
      activeSec = next; selChord = -1; commit(); buildPartTabs(); buildRuler(); buildOrder();
    });
    wrap.appendChild(add);
  }
}
function buildProgs() {
  const wrap = $('#fgProgs'); if (!wrap) return; wrap.textContent = '';
  for (const [name, chords] of PROGRESSIONS[draft.mode] || []) {
    const b = document.createElement('button'); b.className = 'fgProg';
    b.innerHTML = '<span class="fgProgN">' + name + '</span><span class="fgProgC">' + chords.map(c => chordName(c.d, c.q)).join(' ') + '</span>';
    b.title = 'fill this part with ' + name;
    b.addEventListener('click', () => {
      draft.sections[activeSec] = chords.map(c => ({...c}));
      selChord = -1; commit(); buildRuler(); buildEditor();
    });
    wrap.appendChild(b);
  }
}
function buildRuler() {
  const wrap = $('#fgRuler'); if (!wrap) return; wrap.textContent = '';
  const bars = draft.sections[activeSec] || [];
  bars.forEach((spec, i) => {
    const cell = document.createElement('button'); cell.className = 'fgCell' + (i === selChord ? ' sel' : ''); cell.dataset.i = i;
    cell.innerHTML = '<span class="fgCellN">' + (i + 1) + '</span><span class="fgCellC">' + chordName(spec.d, spec.q) + '</span>';
    cell.addEventListener('click', () => { selChord = (selChord === i) ? -1 : i; buildRuler(); buildEditor(); });
    wrap.appendChild(cell);
  });
  const add = document.createElement('button'); add.className = 'fgCell fgCellAdd'; add.title = 'add a bar';
  add.innerHTML = '<span class="fgCellN">add</span><span class="fgCellC">+</span>';
  add.addEventListener('click', () => { if (bars.length < 16) { bars.push({...(bars[bars.length - 1] || {d: 0, q: 'm'})}); selChord = bars.length - 1; commit(); buildRuler(); buildEditor(); } });
  wrap.appendChild(add);
}
/* the direct bar editor — tap a bar above, its chords appear here to set,
   with a plain "remove bar" button (no corner tapping) */
function buildEditor() {
  const wrap = $('#fgEditor'); if (!wrap) return; wrap.textContent = '';
  if (selChord < 0) { wrap.classList.remove('open'); wrap.innerHTML = '<span class="fgPalHint">tap a bar above to change its chord</span>'; return; }
  wrap.classList.add('open');
  const spec = draft.sections[activeSec][selChord];
  const hdr = document.createElement('div'); hdr.className = 'fgEdHdr';
  hdr.innerHTML = '<span class="fgEdTitle">Bar ' + (selChord + 1) + ' · ' + chordName(spec.d, spec.q) + '</span>';
  const done = document.createElement('button'); done.className = 'fgEdDone'; done.textContent = 'done';
  done.addEventListener('click', () => { selChord = -1; buildRuler(); buildEditor(); });
  hdr.appendChild(done); wrap.appendChild(hdr);
  const row = document.createElement('div'); row.className = 'fgEdChords';
  for (const c of palette()) {
    const b = document.createElement('button'); b.className = 'fgChord' + (c.d === spec.d && spec.q !== '5' ? ' cur' : ''); b.textContent = chordName(c.d, c.q);
    b.addEventListener('click', () => { draft.sections[activeSec][selChord] = {d: c.d, q: c.q}; commit(); buildRuler(); buildEditor(); });
    row.appendChild(b);
  }
  const fifth = document.createElement('button'); fifth.className = 'fgChord fgFifth' + (spec.q === '5' ? ' cur' : ''); fifth.textContent = 'open 5th';
  fifth.addEventListener('click', () => { spec.q = '5'; commit(); buildRuler(); buildEditor(); });
  row.appendChild(fifth);
  wrap.appendChild(row);
  const bars = draft.sections[activeSec];
  const rm = document.createElement('button'); rm.className = 'fgEdRemove'; rm.textContent = '🗑 remove bar';
  rm.disabled = bars.length <= 1;
  rm.addEventListener('click', () => { if (bars.length > 1) { bars.splice(selChord, 1); selChord = -1; commit(); buildRuler(); buildEditor(); } });
  wrap.appendChild(rm);
}

/* ---- order ---- */
function buildOrder() {
  const wrap = $('#fgOrder'); if (!wrap) return; wrap.textContent = '';
  draft.order.forEach((name, i) => {
    const chip = document.createElement('button'); chip.className = 'fgOrderChip'; chip.textContent = name; chip.dataset.part = name;
    chip.title = 'tap to remove from the order';
    chip.addEventListener('click', () => { if (draft.order.length > 1) { draft.order.splice(i, 1); commit(); buildOrder(); } });
    wrap.appendChild(chip);
    const a = document.createElement('span'); a.className = 'fgArrow'; a.textContent = '→'; wrap.appendChild(a);
  });
  const loop = document.createElement('span'); loop.className = 'fgArrow'; loop.textContent = '↻'; wrap.appendChild(loop);
  for (const name of Object.keys(draft.sections)) {
    const add = document.createElement('button'); add.className = 'fgOrderAdd'; add.textContent = '+' + name;
    add.addEventListener('click', () => { draft.order.push(name); commit(); buildOrder(); });
    wrap.appendChild(add);
  }
}

/* ---- tracks + shelf (drag to add/remove) ---- */
function buildTracks() {
  const wrap = $('#fgTracks'); wrap.textContent = '';
  const active = ROLES.filter(role => draft._roles[role.key].on);
  if (!active.length) {
    const empty = document.createElement('div'); empty.className = 'fgEmpty'; empty.textContent = 'Drag an instrument here to start your band';
    wrap.appendChild(empty);
  }
  for (const role of active) {
    const r = draft._roles[role.key];
    const lane = document.createElement('div'); lane.className = 'fgLane';
    const head = document.createElement('div'); head.className = 'fgLaneHead';
    head.innerHTML = '<span class="fgLaneIc">' + role.icon + '</span><span class="fgLaneNm">' + role.label + '</span>';
    lane.appendChild(head);
    const body = document.createElement('div'); body.className = 'fgLaneBody';
    if (role.insts.length > 1) {
      const iw = document.createElement('div'); iw.className = 'fgLaneInsts';
      for (const inst of role.insts) {
        const ib = document.createElement('button'); ib.className = 'fgInstOpt'; ib.textContent = INST_LABEL[inst];
        ib.setAttribute('aria-pressed', String(inst === r.inst));
        ib.addEventListener('click', () => { r.inst = inst; for (const o of iw.children) o.setAttribute('aria-pressed', String(o === ib)); commit(); });
        iw.appendChild(ib);
      }
      body.appendChild(iw);
    }
    if (role.dens) {
      const dw = document.createElement('div'); dw.className = 'fgBusy';
      ['Sparse', 'Medium', 'Busy'].forEach((lab, i) => {
        const b = document.createElement('button'); b.className = 'fgBusyOpt'; b.textContent = lab;
        b.setAttribute('aria-pressed', String(r.dens === i + 1));
        b.addEventListener('click', () => { r.dens = i + 1; for (const o of dw.children) o.setAttribute('aria-pressed', String(o === b)); commit(); });
        dw.appendChild(b);
      });
      body.appendChild(dw);
    }
    lane.appendChild(body);
    const del = document.createElement('button'); del.className = 'fgLaneDel'; del.textContent = '✕'; del.setAttribute('aria-label', 'remove track');
    del.addEventListener('click', () => { r.on = false; commit(); buildTracks(); buildShelf(); });
    lane.appendChild(del);
    /* drag a lane down to the shelf to remove it */
    makeDraggable(head, () => ({role: role.key, from: 'track'}), (data, dropZone) => {
      if (dropZone === 'shelf') { draft._roles[data.role].on = false; commit(); buildTracks(); buildShelf(); }
    });
    wrap.appendChild(lane);
  }
}
function buildShelf() {
  const wrap = $('#fgShelf'); wrap.setAttribute('data-drop', 'shelf'); wrap.textContent = '';
  for (const role of ROLES) {
    if (draft._roles[role.key].on) continue;
    const tile = document.createElement('button'); tile.className = 'fgTile';
    tile.innerHTML = '<span class="fgTileIc">' + role.icon + '</span><span class="fgTileNm">' + role.label + '</span>';
    const addIt = () => { draft._roles[role.key].on = true; commit(); buildTracks(); buildShelf(); };
    tile.addEventListener('click', addIt); /* tap also adds */
    makeDraggable(tile, () => ({role: role.key, from: 'shelf'}), (data, dropZone) => {
      if (dropZone === 'tracks') addIt();
    });
    wrap.appendChild(tile);
  }
  if (!wrap.children.length) { const done = document.createElement('span'); done.className = 'fgPalHint'; done.textContent = 'every instrument is in play'; wrap.appendChild(done); }
}

/* ---- now-playing ---- */
function showNow({part, bar}) {
  if (state.styleId !== '__draft') return;
  const fv = $('#viewForge'); if (!fv || !fv.classList.contains('active')) return;
  for (const t of document.querySelectorAll('#fgParts .fgSecTab')) t.classList.toggle('now', t.dataset.part === part);
  for (const c of document.querySelectorAll('#fgRuler .fgCell')) c.classList.toggle('now', part === activeSec && +c.dataset.i === bar);
  for (const o of document.querySelectorAll('#fgOrder .fgOrderChip')) o.classList.toggle('now', o.dataset.part === part);
}
function clearNow() { for (const el of document.querySelectorAll('.now')) el.classList.remove('now'); }

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
  registerSong(song); state.songs.push(song);
  if (state.songs.length > 40) { const drop = state.songs.shift(); unregisterSong(drop.id); }
  persist();
  document.dispatchEvent(new CustomEvent('forge-saved', {detail: {id}}));
  const b = $('#fgSave'); b.textContent = 'Saved ✓'; setTimeout(() => { b.textContent = 'Save to set list'; }, 1600);
}
export function forgeOnShow() { commit(); $('#fgName').value = draft.name; buildProgs(); buildRuler(); buildEditor(); }
export function forgeTransport(playing) {
  const b = $('#fgPreview'); if (b) b.textContent = playing && state.styleId === '__draft' ? '◼ Stop' : '▶ Preview';
  if (!playing) clearNow();
}
