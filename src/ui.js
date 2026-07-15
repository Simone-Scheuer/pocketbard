import {$} from './util.js';
import {NOTE_NAMES, MODES, whistleHint, optimalTonic} from './theory.js';
import {STYLES} from './styles.js';
import {state, persist, MIX_DEFAULTS, bindPersist} from './state.js';
import {clamp} from './util.js';
import * as engine from './engine.js';
import * as forge from './forge.js';
import {unregisterSong} from './styles.js';

const {conductor, ENERGY_TARGETS} = engine;
bindPersist(() => conductor.intensityTarget);

/* ---------- set list ---------- */
function refreshCards() {
  for (const b of document.querySelectorAll('.card')) {
    if (b.dataset.custom) b.setAttribute('aria-pressed', String(state._customSel === b.dataset.custom));
    else b.setAttribute('aria-pressed', String(!state._customSel && b.dataset.id === (state.pending.styleId ?? state.styleId)));
  }
}
function buildCards() {
  const wrap = $('#cards');
  wrap.textContent = '';
  for (const [id, sty] of Object.entries(STYLES)) {
    if (id === '__draft') continue; /* the Forge's live draft is not a set-list tune */
    const meter = sty.stepsPerBeat === 6 ? (sty.beatsPerBar === 3 ? '9/8' : '6/8')
      : (sty.beatsPerBar === 3 ? '3/4' : sty.beatsPerBar === 2 ? '2/4' : '4/4');
    const b = document.createElement('button');
    b.className = 'card' + (sty._user ? ' custom' : ''); b.dataset.id = id;
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    b.innerHTML = '<span class="ic">' + sty.icon + '</span><span class="nm">' + esc(sty.name) +
      '</span><span class="mt">' + meter + ' · ' + MODES[sty.mode].label + ' · ' + sty.bpm + '</span>' +
      (sty._user ? '<span class="del" role="button" aria-label="Forget this tune" title="Forget this tune">✕</span>' : '');
    b.addEventListener('click', e => {
      if (e.target.classList.contains('del')) {
        if (confirm('Forget “' + sty.name + '”?')) {
          state.songs = state.songs.filter(s => s.id !== id);
          unregisterSong(id); persist(); buildCards();
        }
        return;
      }
      selectStyle(id);
    });
    wrap.appendChild(b);
  }
  for (const c of state.customs) {
    const sty = STYLES[c.base];
    const b = document.createElement('button');
    b.className = 'card custom'; b.dataset.custom = c.id;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    b.innerHTML = '<span class="ic">📜</span><span class="nm">' + esc(c.name) +
      '</span><span class="mt">' + NOTE_NAMES[c.tonic] + ' ' + MODES[sty.mode].label + ' · ' + c.tempoTarget + '</span>' +
      '<span class="del" role="button" aria-label="Forget this sound" title="Forget this sound">✕</span>';
    b.addEventListener('click', e => {
      if (e.target.classList.contains('del')) {
        if (confirm('Forget "' + c.name + '"?')) {
          state.customs = state.customs.filter(x => x.id !== c.id);
          if (state._customSel === c.id) state._customSel = null;
          persist(); buildCards(); refreshCards();
        }
        return;
      }
      applyCustom(c);
    });
    wrap.appendChild(b);
  }
  refreshCards();
}
function snapshotCurrent(name) {
  const t = {...state.toggles}; delete t.hearth;
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    base: state.pending.styleId ?? state.styleId,
    tonic: state.pending.tonic ?? state.tonic,
    tempoTarget: state.tempoTarget,
    intensity: conductor.intensityTarget,
    toggles: t, voices: {...state.voices}, mix: {...state.mix}, blend: state.blend,
  };
}
function applyCustom(c) {
  state._customSel = c.id;
  if (state.playing) { state.pending.styleId = c.base; state.pending.tonic = c.tonic; }
  else { state.styleId = c.base; state.tonic = c.tonic; }
  state.tempoTarget = c.tempoTarget;
  $('#tempo').value = c.tempoTarget; $('#bpmOut').textContent = c.tempoTarget;
  conductor.intensityTarget = c.intensity;
  if (!state.playing) conductor.intensity = c.intensity;
  Object.assign(state.toggles, c.toggles);
  state.voices = {...c.voices};
  Object.assign(state.mix, c.mix);
  state.blend = !!c.blend;
  engine.applyMix();
  if (state.playing) $('#nowSub').textContent = c.name;
  syncAllUI(); persist();
}
function refreshChips() {
  for (const b of document.querySelectorAll('.chip'))
    b.setAttribute('aria-pressed', String(!!state.toggles[b.dataset.k]));
}
function refreshVoices() {
  for (const [key, elId] of [['strings', '#voxStrings'], ['drums', '#voxDrums']]) {
    const wrap = $(elId);
    [...wrap.children].forEach((b, i) =>
      b.setAttribute('aria-pressed', String(state.voices[key] === VOICE_CHOICES[key][i][0])));
  }
}
function syncAllUI() {
  refreshCards(); refreshChips(); refreshVoices(); refreshChipAvail(); refreshKeyUI();
  syncFervorUI(); wsSyncInputs();
  $('#blendBtn').setAttribute('aria-pressed', String(state.blend));
}
function buildKeys() {
  const wrap = $('#keys');
  NOTE_NAMES.forEach((n, pc) => {
    const b = document.createElement('button');
    b.className = 'key'; b.textContent = n; b.dataset.pc = pc;
    b.setAttribute('aria-pressed', String(pc === state.tonic));
    b.addEventListener('click', () => selectKey(pc));
    wrap.appendChild(b);
  });
}
const CHIPS = [['drums','🥁 Drum'],['jingle','🔔 Jingle'],['pluck','🪕 Strings'],
  ['fiddle','🎻 Fiddle'],['bass','𝄢 Bass'],['drone','🐝 Drone'],['pad','🌬️ Air'],['hearth','🔥 Hearth']];
function buildChips() {
  const wrap = $('#chips');
  for (const [k, label] of CHIPS) {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.k = k; b.textContent = label;
    b.setAttribute('aria-pressed', String(!!state.toggles[k]));
    b.addEventListener('click', () => {
      state.toggles[k] = !state.toggles[k];
      b.setAttribute('aria-pressed', String(state.toggles[k]));
      if (k === 'hearth') engine.setHearth(state.toggles[k]);
      persist(); refreshChipAvail();
    });
    wrap.appendChild(b);
  }
}
function refreshChipAvail() {
  const sty = STYLES[state.pending.styleId ?? state.styleId];
  for (const b of document.querySelectorAll('.chip')) {
    const k = b.dataset.k;
    let has = true;
    if (k === 'jingle') has = !!Object.values(sty.parts).some(p => p.kind === 'jingle' || p.gen === 'backbeatTss');
    else if (k === 'fiddle') has = !!Object.values(sty.parts).some(p => p.inst === 'fiddle');
    else if (k === 'drone') has = sty.drone > 0;
    else if (k === 'pad') has = sty.pad > 0 || Object.values(sty.parts).some(p => p.inst === 'accordion');
    else if (k === 'drums') has = !!Object.values(sty.parts).some(p => p.kind === 'drum');
    else if (k === 'pluck') has = !!Object.values(sty.parts).some(p => p.kind === 'harmony');
    else if (k === 'bass') has = !!Object.values(sty.parts).some(p => p.kind === 'bass');
    b.classList.toggle('na', !has);
  }
}
function refreshKeyUI() {
  const styId = state.pending.styleId ?? state.styleId;
  const tonic = state.pending.tonic ?? state.tonic;
  const sty = STYLES[styId];
  for (const b of document.querySelectorAll('.key'))
    b.setAttribute('aria-pressed', String(+b.dataset.pc === tonic));
  for (const el of document.querySelectorAll('.modeNameEl'))
    el.textContent = NOTE_NAMES[tonic] + ' ' + MODES[sty.mode].label;
  for (const el of document.querySelectorAll('.whistleHintEl'))
    el.textContent = whistleHint(tonic, sty.mode);
  const note = $('#autoKeyNote');
  if (note) note.textContent = state.myKey != null
    ? 'Auto-keying for your ' + NOTE_NAMES[state.myKey] + ' instrument. A key you tap above sticks until you pick another tune.'
    : 'Set your whistle or harp’s key and every tune you pick will re-key itself to fit it.';
}
function selectStyle(id) {
  state._customSel = null;
  const sty = STYLES[id];
  /* with an instrument set, every tune re-keys itself to fit the player */
  const tonic = state.myKey != null ? optimalTonic(sty.mode, state.myKey) : sty.tonic;
  if (state.playing) { state.pending.styleId = id; state.pending.tonic = tonic; }
  else { state.styleId = id; state.tonic = tonic; }
  state.tempoTarget = sty.bpm;
  $('#tempo').value = sty.bpm; $('#bpmOut').textContent = sty.bpm;
  if (state.playing) $('#nowSub').textContent = sty.name;
  refreshCards(); refreshKeyUI(); refreshChipAvail(); persist();
}
function selectKey(pc) {
  if (state.playing) state.pending.tonic = pc; else state.tonic = pc;
  refreshKeyUI(); persist();
}

/* ---------- voice pickers ---------- */
const VOICE_CHOICES = {
  strings: [[null, 'Tune’s pick'], ['lute', 'Lute'], ['harp', 'Harp'], ['oud', 'Oud']],
  drums: [[null, 'Tune’s pick'], ['bodhran', 'Bodhrán'], ['darbuka', 'Darbuka'], ['bongos', 'Bongos']],
};
function buildVoices() {
  for (const [key, elId] of [['strings', '#voxStrings'], ['drums', '#voxDrums']]) {
    const wrap = $(elId);
    for (const [val, label] of VOICE_CHOICES[key]) {
      const b = document.createElement('button');
      b.className = 'vopt'; b.textContent = label;
      b.setAttribute('aria-pressed', String(state.voices[key] === val));
      b.addEventListener('click', () => {
        state.voices[key] = val;
        for (const o of wrap.children) o.setAttribute('aria-pressed', String(o === b));
        persist();
      });
      wrap.appendChild(b);
    }
  }
}

/* ---------- my key (player's instrument) ---------- */
const MYKEY_CHOICES = [[null, 'Off'], [0, 'C'], [2, 'D'], [3, 'E♭'], [5, 'F'], [7, 'G'], [9, 'A'], [10, 'B♭']];
function buildMyKey() {
  const wrap = $('#voxMyKey');
  for (const [pc, label] of MYKEY_CHOICES) {
    const b = document.createElement('button');
    b.className = 'vopt'; b.textContent = label;
    b.setAttribute('aria-pressed', String(state.myKey === pc));
    b.addEventListener('click', () => {
      state.myKey = pc;
      for (const o of wrap.children) o.setAttribute('aria-pressed', String(o === b));
      if (pc != null) {
        const sty = STYLES[state.pending.styleId ?? state.styleId];
        selectKey(optimalTonic(sty.mode, pc));
      }
      persist();
    });
    wrap.appendChild(b);
  }
}

/* ---------- field notes (the LOG half of the working procedure) ---------- */
const NOTES_KEY = 'pocketbard_fieldnotes';
let fieldNotes = [];
try { fieldNotes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); } catch (e) {}
function saveNotes() { try { localStorage.setItem(NOTES_KEY, JSON.stringify(fieldNotes)); } catch (e) {} }
const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function captureNote() {
  const custom = state._customSel ? state.customs.find(c => c.id === state._customSel) : null;
  const sty = STYLES[state.styleId];
  fieldNotes.push({
    at: new Date().toISOString(),
    tune: custom ? custom.name : sty.name,
    key: NOTE_NAMES[state.tonic] + ' ' + MODES[sty.mode].label,
    bpm: state.tempoTarget,
    intensity: +conductor.intensity.toFixed(2),
    bar: state.barIdx, playing: state.playing,
    toggles: {...state.toggles}, voices: {...state.voices}, mix: {...state.mix},
    text: '',
  });
  saveNotes(); renderNotes();
  const b = $('#noteBtn');
  b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 450);
}
function renderNotes() {
  $('#fnCount').textContent = fieldNotes.length ? fieldNotes.length + ' marked' : 'none yet';
  const wrap = $('#fnList'); wrap.textContent = '';
  fieldNotes.slice().reverse().forEach(n => {
    const row = document.createElement('div'); row.className = 'fnRow';
    const t = new Date(n.at);
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    row.innerHTML = '<span class="fnMeta">' + hh + ' · ' + escText(n.tune) + ' · ' + n.key +
      ' · bar ' + n.bar + ' · ' + Math.round(n.intensity * 100) + '%</span>' +
      '<input class="fnText" placeholder="what did you hear?" value="' + escText(n.text) + '">' +
      '<button class="fnDel" aria-label="Delete this note">✕</button>';
    row.querySelector('.fnText').addEventListener('input', e => { n.text = e.target.value; saveNotes(); });
    row.querySelector('.fnDel').addEventListener('click', () => {
      fieldNotes = fieldNotes.filter(x => x !== n); saveNotes(); renderNotes();
    });
    wrap.appendChild(row);
  });
}
function bindNotes() {
  $('#noteBtn').addEventListener('click', captureNote);
  $('#fnCopy').addEventListener('click', () => {
    const json = JSON.stringify(fieldNotes, null, 1);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).catch(() => {});
    const b = $('#fnCopy'); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy all'; }, 1400);
  });
  $('#fnClear').addEventListener('click', () => {
    if (fieldNotes.length && confirm('Clear all ' + fieldNotes.length + ' field notes?')) {
      fieldNotes = []; saveNotes(); renderNotes();
    }
  });
  renderNotes();
}

/* ---------- performance surface ---------- */
function syncFervorUI() {
  const x = conductor.intensityTarget;
  $('#fervor').value = Math.round(x * 100);
  $('#fervorOut').textContent = x < .33 ? 'Calm' : x < .67 ? 'Lively' : 'Rowdy';
  state.energy = x < .33 ? 0 : x < .67 ? 1 : 2;
  for (const o of document.querySelectorAll('#revelry button'))
    o.setAttribute('aria-pressed', String(+o.dataset.e === state.energy));
}
function bindPerformance() {
  $('#fervor').addEventListener('input', e => {
    conductor.intensityTarget = +e.target.value / 100;
    if (!state.playing) conductor.intensity = conductor.intensityTarget;
    syncFervorUI(); persist();
  });
  for (const b of document.querySelectorAll('#revelry button')) {
    b.addEventListener('click', () => {
      conductor.intensityTarget = ENERGY_TARGETS[+b.dataset.e];
      if (!state.playing) conductor.intensity = conductor.intensityTarget;
      syncFervorUI(); persist();
    });
  }
  $('#trUp').addEventListener('click', () => selectKey(((state.pending.tonic ?? state.tonic) + 1) % 12));
  $('#trDown').addEventListener('click', () => selectKey(((state.pending.tonic ?? state.tonic) + 11) % 12));
  $('#blendBtn').addEventListener('click', () => {
    state.blend = !state.blend;
    $('#blendBtn').setAttribute('aria-pressed', String(state.blend));
    persist();
  });
  $('#fullBtn').addEventListener('click', () => {
    state.fullBand = !state.fullBand;
    $('#fullBtn').setAttribute('aria-pressed', String(state.fullBand));
    persist();
  });
}

/* ---------- workshop ---------- */
/* two families on purpose: Levels are how LOUD each part is; Feel is how
   the band BEHAVES (density, space, timbre, timing) */
const WS_GROUPS = [
  ['How loud', [
    ['drums', 'Drums', 0, 150, 1],
    ['jingle', 'Jingles', 0, 150, 1],
    ['strings', 'Strings', 0, 150, 1],
    ['fiddle', 'Fiddle', 0, 150, 1],
    ['bass', 'Bass', 0, 150, 1],
    ['drone', 'Drone', 0, 150, 1],
    ['air', 'Air', 0, 150, 1],
  ]],
  ['How they play', [
    ['texture', 'Pitter-patter', 0, 150, 1],
    ['fills', 'Fills', 0, 150, 1],
    ['swing', 'Swing', 0, 150, 1],
    ['human', 'Looseness', 0, 200, 1],
    ['warmth', 'Bass tone', 300, 2400, 10],
    ['reverb', 'Room', 0, 150, 1],
  ]],
];
const WS_DEFS = WS_GROUPS.flatMap(([, defs]) => defs);
const wsValue = key => key === 'warmth' ? state.mix.warmth : Math.round(state.mix[key] * 100);
const wsLabel = key => key === 'warmth' ? state.mix.warmth + ' Hz' : Math.round(state.mix[key] * 100) + '%';
function wsSyncJson() { $('#wsJson').value = JSON.stringify(state.mix); }
function wsSyncInputs() {
  for (const [key] of WS_DEFS) {
    const row = document.querySelector('.wsRow[data-k="' + key + '"]');
    row.querySelector('input').value = wsValue(key);
    row.querySelector('.wsVal').textContent = wsLabel(key);
  }
  wsSyncJson();
}
function buildWorkshop() {
  const wrap = $('#wsRows');
  for (const [groupName, defs] of WS_GROUPS) {
    const h = document.createElement('h3');
    h.className = 'wsGroup'; h.textContent = groupName;
    wrap.appendChild(h);
    for (const [key, label, min, max, step] of defs) {
      const row = document.createElement('div');
      row.className = 'wsRow'; row.dataset.k = key;
      row.innerHTML = '<label for="ws_' + key + '">' + label + '</label>' +
        '<input id="ws_' + key + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + wsValue(key) + '">' +
        '<span class="wsVal">' + wsLabel(key) + '</span>';
      row.querySelector('input').addEventListener('input', e => {
        const v = +e.target.value;
        state.mix[key] = key === 'warmth' ? v : v / 100;
        row.querySelector('.wsVal').textContent = wsLabel(key);
        engine.applyMix(); persist(); wsSyncJson();
      });
      wrap.appendChild(row);
    }
  }
  $('#wsReset').addEventListener('click', () => {
    state.mix = Object.assign({}, MIX_DEFAULTS);
    wsSyncInputs(); engine.applyMix(); persist();
  });
  $('#wsCopy').addEventListener('click', () => {
    wsSyncJson();
    const ta = $('#wsJson'); ta.select();
    let ok = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).catch(() => {}); ok = true;
    } else { try { ok = document.execCommand('copy'); } catch (e) {} }
    const b = $('#wsCopy'); b.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => { b.textContent = 'Copy'; }, 1400);
  });
  $('#wsApply').addEventListener('click', () => {
    try {
      const j = JSON.parse($('#wsJson').value);
      for (const k of Object.keys(MIX_DEFAULTS)) if (typeof j[k] === 'number') {
        state.mix[k] = k === 'warmth' ? clamp(j[k], 300, 2400) : clamp(j[k], 0, 2);
      }
      wsSyncInputs(); engine.applyMix(); persist();
      const b = $('#wsApply'); b.textContent = 'Applied'; setTimeout(() => { b.textContent = 'Apply'; }, 1400);
    } catch (e) {
      const b = $('#wsApply'); b.textContent = 'Bad JSON'; setTimeout(() => { b.textContent = 'Apply'; }, 1400);
    }
  });
  $('#wsShare').addEventListener('toggle', wsSyncJson);
}

/* ---------- transport + meters ---------- */
function bindTransport() {
  $('#playBtn').addEventListener('click', engine.togglePlay);
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); engine.togglePlay(); }
  });
  $('#tempo').addEventListener('input', e => {
    state.tempoTarget = +e.target.value;
    $('#bpmOut').textContent = e.target.value;
    persist();
  });
  $('#vol').addEventListener('input', e => { engine.setVolume(+e.target.value); persist(); });
  engine.on('transport', ({playing, styleName}) => {
    $('#playBtn').classList.toggle('playing', playing);
    $('#playBtn').setAttribute('aria-label', playing ? 'Stop' : 'Play');
    forge.forgeTransport(playing);
    raf.styleName = styleName || raf.styleName;
    if (playing) { $('#nowSub').textContent = styleName; }
    else { $('#chordNow').textContent = '—'; $('#nowSub').textContent = 'tap play to strike up the band'; }
  });
}
function raf() {
  requestAnimationFrame(raf);
  const AC = engine.getAC();
  if (!AC) return;
  const now = AC.currentTime;
  const ring = $('#ring'), flame = $('#flame'), chordNow = $('#chordNow');
  while (engine.beatQueue.length && engine.beatQueue[0] <= now) {
    engine.beatQueue.shift();
    ring.classList.remove('pulse'); void ring.offsetWidth; ring.classList.add('pulse');
  }
  while (engine.chordQueue.length && engine.chordQueue[0].t <= now) {
    chordNow.textContent = engine.chordQueue.shift().label;
  }
  while (engine.passageQueue.length && engine.passageQueue[0].t <= now) {
    const p = engine.passageQueue.shift();
    if (state.playing) {
      const custom = state._customSel ? state.customs.find(c => c.id === state._customSel) : null;
      const name = custom ? custom.name : STYLES[state.styleId].name;
      $('#nowSub').textContent = name + ' · ' + p.label;
    }
  }
  const analyser = engine.getAnalyser();
  if (analyser) {
    if (!raf.vu) raf.vu = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(raf.vu);
    let sum = 0;
    for (let i = 0; i < raf.vu.length; i += 4) { const x = (raf.vu[i] - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / (raf.vu.length / 4));
    raf.smoothed = (raf.smoothed || 0) + (rms - (raf.smoothed || 0)) * .25;
    const s = .55 + Math.min(2.2, raf.smoothed * 7);
    flame.style.transform = 'scaleY(' + s.toFixed(3) + ') scaleX(' + (0.8 + s * .15).toFixed(3) + ')';
  }
}
export const rms = () => raf.smoothed || 0;

const VIEW_TABS = [['#tabPlay', '#viewPlay'], ['#tabSetup', '#viewSetup'], ['#tabForge', '#viewForge']];
function switchViewTo(tabSel) {
  for (const [t, v] of VIEW_TABS) {
    $(t).setAttribute('aria-selected', String(t === tabSel));
    $(v).classList.toggle('active', t === tabSel);
  }
  if (tabSel === '#tabForge') forge.forgeOnShow();
}
function bindViews() {
  for (const [tabSel] of VIEW_TABS) $(tabSel).addEventListener('click', () => switchViewTo(tabSel));
  $('#fgAddBar').addEventListener('click', forge.forgeAddBar);
  $('#fgDelBar').addEventListener('click', forge.forgeDelBar);
  document.addEventListener('forge-saved', e => {
    buildCards();
    const id = e.detail.id;
    switchViewTo('#tabPlay');
    const card = document.querySelector('.card[data-id="' + id + '"]');
    if (card) { card.click(); card.scrollIntoView({block: 'nearest'}); }
  });
  $('#keepBtn').addEventListener('click', () => {
    const base = STYLES[state.pending.styleId ?? state.styleId];
    const name = prompt('Name this sound:', base.name + ' (mine)');
    if (!name) return;
    state.customs.push(snapshotCurrent(name.slice(0, 40)));
    if (state.customs.length > 20) state.customs.shift();
    persist(); buildCards();
  });
}

export function init() {
  buildCards(); buildKeys(); buildMyKey(); buildChips(); buildVoices(); buildWorkshop();
  bindPerformance(); bindTransport(); bindViews(); bindNotes(); forge.initForge();
  $('#tempo').value = state.tempoTarget; $('#bpmOut').textContent = state.tempoTarget;
  $('#vol').value = state.volume;
  $('#blendBtn').setAttribute('aria-pressed', String(state.blend));
  $('#fullBtn').setAttribute('aria-pressed', String(state.fullBand));
  syncFervorUI(); refreshKeyUI(); refreshChipAvail();
  raf();
  if (state.toggles.hearth) state.toggles.hearth = false; /* fire needs a tap */
}
