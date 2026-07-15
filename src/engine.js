/* ============================================================
   PocketBard engine — platform architecture
   Layers, bottom to top:
   1. Audio core            context, master chain, node helpers
   2. Instruments           playable objects: technique + body + bus,
                            sample-first with synthesis fallback
   3. Generators            procedural per-bar/per-section event makers
   4. Conductor             live musical control (intensity, tempo)
   5. Sequencer             lookahead scheduler: parts -> events -> instruments
   ============================================================ */
import {clamp, lerp, rand, choice, mtof} from './util.js';
import {makeChord, passingNote, MODES} from './theory.js';
import {STYLES, DRUM_MAPS, validateStyles} from './styles.js';
import {state, persist} from './state.js';
import {SampleLibrary} from './samples.js';

/* ---------- tiny event emitter (engine -> ui) ---------- */
const listeners = {};
export function on(ev, cb) { (listeners[ev] ??= []).push(cb); }
function emit(ev, data) { for (const cb of listeners[ev] || []) cb(data); }

/* ================= conductor ================= */
export const conductor = {
  intensity: .55, intensityTarget: .55,
  advance(dt) { this.intensity += clamp(this.intensityTarget - this.intensity, -.25 * dt, .25 * dt); },
  band() { return this.intensity < .33 ? 'calm' : this.intensity < .67 ? 'lively' : 'rowdy'; },
};
export const ENERGY_TARGETS = [.15, .55, .9];
conductor.intensityTarget = conductor.intensity =
  (typeof state._li === 'number') ? state._li : (ENERGY_TARGETS[state.energy] ?? .55);

/* ================= audio core ================= */
let AC = null, master, analyser, mixBus, verb, verbGain, noiseBuf;
export const samples = new SampleLibrary();
export const getAC = () => AC;
export const getAnalyser = () => analyser;

export function setVolume(v) {
  state.volume = v;
  if (master) master.gain.setTargetAtTime(v, AC.currentTime, .05);
}

export function initAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  master = AC.createGain(); master.gain.value = state.volume;
  analyser = AC.createAnalyser(); analyser.fftSize = 1024;
  mixBus = AC.createGain();
  verb = AC.createConvolver(); verb.buffer = makeIR(1.4, 2.8); /* small room, not a hall */
  verbGain = AC.createGain(); verbGain.gain.value = STYLES[state.styleId].reverb * state.mix.reverb;
  /* fixed pre-gain into a tanh soft-clip: warm, deterministic ceiling
     (DynamicsCompressor's auto makeup gain pushes peaks to full scale) */
  const pre = AC.createGain(); pre.gain.value = .46;
  const sat = AC.createWaveShaper();
  const curve = new Float32Array(1024), K = 2.5, norm = Math.tanh(K);
  for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(K * x) / norm; }
  sat.curve = curve; sat.oversample = '2x';
  mixBus.connect(pre);
  mixBus.connect(verb); verb.connect(verbGain); verbGain.connect(pre);
  pre.connect(sat); sat.connect(master);
  master.connect(analyser); analyser.connect(AC.destination);
  noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  buildRoster();
  samples.load(AC).then(() => { if (samples.ready) emit('samples', samples); });
  /* silent unlock blip for iOS */
  const b = AC.createBufferSource(); b.buffer = AC.createBuffer(1, 1, AC.sampleRate);
  b.connect(AC.destination); b.start();
}

function makeIR(dur, decay) {
  const sr = AC.sampleRate, len = Math.floor(sr * dur);
  const buf = AC.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len, w = Math.random() * 2 - 1;
      const k = Math.max(.045, .4 * (1 - t)); /* tail darkens over time */
      lp += k * (w - lp);
      d[i] = lp * Math.pow(1 - t, decay) * .55;
    }
  }
  return buf;
}
function envGain(t, peak, a, d) {
  const g = AC.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setTargetAtTime(0, t + a, d / 3);
  return g;
}
function noiseHitTo(dest, t, vel, {f, q = 1, dur = .05, hp = 0, attack = .001}) {
  const src = AC.createBufferSource(); src.buffer = noiseBuf;
  src.loop = true; src.loopStart = 0; src.loopEnd = 1;
  let node = src;
  if (hp) { const h = AC.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; node.connect(h); node = h; }
  const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
  node.connect(bp);
  const g = envGain(t, vel, attack, dur);
  bp.connect(g); g.connect(dest);
  src.start(t, Math.random() * .9); src.stop(t + attack + dur * 3 + .05);
}
function pingTo(dest, t, f, vel, dur) {
  const o = AC.createOscillator(); o.type = 'sine'; o.frequency.value = f;
  const g = envGain(t, vel, .001, dur);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur * 3 + .05);
}
/* membrane drum model: fundamental + inharmonic skin partials (circular-
   membrane ratios), subtle pitch settle, per-hit tension drift, beater slap.
   Partial stack normalized: in-phase attacks would otherwise sum too hot. */
function membraneTo(dest, t, vel, o) {
  const f = o.f0 * rand(.97, 1.03);
  const scale = 1.15 / o.partials.reduce((s, p) => s + p[1], 0);
  for (const [ratio, g0, dm] of o.partials) {
    const g = g0 * scale;
    const osc = AC.createOscillator(); osc.type = 'sine';
    const fr = f * ratio;
    osc.frequency.setValueAtTime(fr * (o.sweep || 1.2), t);
    osc.frequency.exponentialRampToValueAtTime(fr, t + .04);
    const gn = envGain(t, vel * g, .003, o.dur * dm);
    osc.connect(gn); gn.connect(dest);
    osc.start(t); osc.stop(t + o.dur * dm * 3 + .1);
  }
  if (o.slap) noiseHitTo(dest, t, vel * o.slap, {f: o.slapF, q: .9, dur: .03});
}
function renderKS(freq, p, sr) {
  const N = Math.max(2, Math.round(sr / freq));
  const len = Math.floor(sr * p.dur);
  const out = new Float32Array(len);
  let buf = new Float32Array(N), lp = 0;
  for (let i = 0; i < N; i++) { const w = Math.random() * 2 - 1; lp += p.bright * (w - lp); buf[i] = lp; }
  const pp = Math.max(1, Math.floor(N * p.pick));
  const ex = new Float32Array(N);
  for (let i = 0; i < N; i++) ex[i] = buf[i] - .9 * buf[(i - pp + N) % N];
  buf = ex;
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const cur = buf[idx], nxt = buf[(idx + 1) % N];
    out[i] = cur;
    buf[idx] = p.damp * .5 * (cur + nxt);
    idx = (idx + 1) % N;
  }
  return out;
}

/* ================= instruments ================= */
export const INSTRUMENTS = {};
export const HAND_DRUMS = ['bodhran', 'darbuka', 'bongos'];
export const HARMONY_INSTS = ['lute', 'harp', 'oud'];

class Instrument {
  constructor(def) { this.def = def; this.id = def.id; this.out = null; INSTRUMENTS[def.id] = this; }
  ensureBus() {
    if (this.out) return this.out;
    const d = this.def;
    const g = AC.createGain();
    g.gain.value = d.gain * (state.mix[d.group] ?? 1);
    let tail = g;
    for (const b of d.body || []) {
      const f = AC.createBiquadFilter(); f.type = 'peaking';
      f.frequency.value = b.f; f.Q.value = b.q; f.gain.value = b.g;
      tail.connect(f); tail = f;
    }
    if (d.warmth) { /* user-tunable lowpass (Workshop "Bass tone") */
      const lp = AC.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = state.mix.warmth; lp.Q.value = .4;
      tail.connect(lp); tail = lp; this._warmth = lp;
    }
    if (d.group !== 'jingle' && d.id !== 'hearth') {
      /* ribbon-mic warmth: folk recordings roll the top off everything
         except the jingles' shimmer */
      const shelf = AC.createBiquadFilter(); shelf.type = 'highshelf';
      shelf.frequency.value = 7500; shelf.gain.value = -3;
      tail.connect(shelf); tail = shelf;
    }
    if (AC.createStereoPanner) {
      const p = AC.createStereoPanner(); p.pan.value = d.pan || 0;
      tail.connect(p); p.connect(mixBus);
    } else tail.connect(mixBus);
    this._gain = g; this.out = g;
    return g;
  }
  /* play a sampled one-shot through a velocity gain, tiny rate jitter */
  playBuffer(t, buffer, vel, rate = 1) {
    const src = AC.createBufferSource(); src.buffer = buffer;
    src.playbackRate.value = rate * (1 + rand(-.004, .004));
    const g = AC.createGain(); g.gain.value = vel;
    src.connect(g); g.connect(this.out);
    src.start(t);
  }
}

/* strings: sampled notes when available, else Karplus-Strong + body;
   a player with strum technique and direction memory either way */
class Strings extends Instrument {
  constructor(def) { super(def); this.cache = new Map(); this.lastDir = 'up'; }
  buffer(midi) {
    let arr = this.cache.get(midi);
    if (!arr) { arr = [this.render(midi), this.render(midi), this.render(midi)]; this.cache.set(midi, arr); }
    return choice(arr);
  }
  render(midi) {
    const p = this.def.ks, sr = AC.sampleRate, f = mtof(midi);
    const len = Math.floor(sr * p.dur);
    const data = renderKS(f, p, sr);
    if (p.layers > 1) {
      const l2 = renderKS(f * Math.pow(2, p.detune / 1200), p, sr);
      for (let i = 0; i < len; i++) data[i] = (data[i] + l2[i]) * .5;
    }
    const fadeN = Math.floor(sr * .03);
    for (let i = 0; i < fadeN; i++) data[len - 1 - i] *= i / fadeN;
    let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
    const g = .9 / (peak || 1); for (let i = 0; i < len; i++) data[i] *= g;
    const b = AC.createBuffer(1, len, sr); b.getChannelData(0).set(data);
    return b;
  }
  pluck(t, midi, vel) {
    this.ensureBus();
    const sampled = samples.note(this.id, midi);
    if (sampled) { this.playBuffer(t, sampled.buffer, vel * samples.noteGain(this.id), sampled.rate); return; }
    const src = AC.createBufferSource(); src.buffer = this.buffer(midi);
    src.playbackRate.value = 1 + rand(-.0007, .0007);
    const g = AC.createGain();
    if (this.def.softAttack) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + this.def.softAttack); }
    else g.gain.value = vel;
    src.connect(g); g.connect(this.out);
    src.start(t);
    const th = this.def.thock; /* body knock: low-note shape without brightness */
    if (th) noiseHitTo(this.out, t, vel * th.g, {f: th.f, q: th.q, dur: th.dur});
  }
  /* a strum is played, not triggered: direction alternates (strong beats
     force down), rake speed follows the band, velocity follows a contour,
     quiet strums sometimes catch only the top strings */
  strum(t, chord, vel, o = {}) {
    this.ensureBus();
    let tones = chord.strum;
    if (o.count) tones = o.top ? tones.slice(-o.count) : tones.slice(0, o.count);
    else if (vel < .5 && Math.random() < .3) tones = tones.slice(-(2 + (Math.random() < .5 ? 1 : 0)));
    let dir = o.dir || 'auto';
    if (dir === 'auto') dir = o.strong ? 'down' : (this.lastDir === 'down' ? 'up' : 'down');
    this.lastDir = dir;
    if (dir === 'up') tones = tones.slice().reverse();
    const drive = clamp(vel * .6 + conductor.intensity * .5, 0, 1);
    const rake = lerp(.042, .010, drive) * rand(.8, 1.25); /* lazy rake -> tight snap */
    const n = tones.length;
    let tt = t, gap = n > 1 ? rake / (n - 1) : 0;
    tones.forEach((off, i) => {
      const x = n > 1 ? i / (n - 1) : 0;
      const contour = dir === 'down' ? lerp(.78, 1, x) : lerp(.95, .68, x);
      this.pluck(tt, chord.rootMidi + off, vel * contour * rand(.92, 1.06));
      tt += gap * rand(.75, 1.3); gap *= .88; /* strums accelerate through the strings */
    });
  }
}

/* hand drums: sampled strokes when available, else membrane synthesis */
class HandDrum extends Instrument {
  _play(t, name, vel) {
    const sampled = samples.hit(this.id, name);
    if (sampled) { this.playBuffer(t, sampled, vel * samples.gain(this.id, name)); return; }
    const v = this.def.voices[name];
    if (!v) return;
    if (typeof v === 'function') v(t, vel, this);
    else membraneTo(this.out, t, vel, v);
  }
  stroke(t, name, vel) {
    this.ensureBus();
    /* one player, two hands: the same drum can't re-sound faster than a
       human could strike it — the weaker of two colliding hits is dropped */
    const gap = this.def.minGap ?? .048;
    if (this._lastT !== undefined && Math.abs(t - this._lastT) < gap && vel <= this._lastV) return;
    this._lastT = t; this._lastV = vel;
    this._play(t, name, vel);
  }
}

/* bowed/bellows sustains (fiddle, accordion): sampled sustain through an
   attack/release envelope; synth formant fallback when unsampled */
class Bowed extends Instrument {
  bow(t, midi, durSec, vel) {
    this.ensureBus();
    const a = this.def.attack ?? .2, rel = this.def.release ?? .35;
    const g = AC.createGain();
    const peak = vel * samples.noteGain(this.id);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(0, t + Math.max(a, durSec - rel * .5), rel / 3);
    g.connect(this.out);
    const stopAt = t + durSec + rel * 3;
    const sampled = samples.note(this.id, midi);
    if (sampled) {
      const src = AC.createBufferSource(); src.buffer = sampled.buffer;
      src.playbackRate.value = sampled.rate * (1 + rand(-.002, .002));
      src.connect(g); src.start(t); src.stop(stopAt);
      return;
    }
    /* fallback: detuned saws -> violin-ish formant bandpasses */
    const pre = AC.createGain(); pre.gain.value = .16;
    for (const det of [-6, 5]) {
      const o = AC.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = mtof(midi); o.detune.value = det;
      o.connect(pre); o.start(t); o.stop(stopAt);
    }
    for (const [f, q, fg] of [[300, 3.5, .9], [700, 3.5, .7], [3000, 2, .3]]) {
      const bp = AC.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = f; bp.Q.value = q;
      const bg = AC.createGain(); bg.gain.value = fg;
      pre.connect(bp); bp.connect(bg); bg.connect(g);
    }
  }
}

/* jingles/cymbal-ish metals: sampled when available, else a cluster of
   detuned high partials + breath noise */
class Jingle extends Instrument {
  hit(t, vel, o = {}) {
    this.ensureBus();
    const artic = o.open ? 'open' : 'closed';
    const sampled = samples.hit(this.id, artic);
    if (sampled) { this.playBuffer(t, sampled, vel * samples.gain(this.id, artic)); return; }
    const d = this.def, dur = (o.open ? d.openDur : d.closedDur) * rand(.85, 1.15);
    for (const [f0, g] of d.partials || []) {
      const osc = AC.createOscillator(); osc.type = 'sine';
      osc.frequency.value = f0 * rand(.97, 1.03);
      const gn = envGain(t, vel * g, d.attack || .001, dur);
      osc.connect(gn); gn.connect(this.out);
      osc.start(t); osc.stop(t + dur * 3 + .1);
    }
    if (d.noise) noiseHitTo(this.out, t, vel * d.noise.g,
      {f: d.noise.f, q: d.noise.q, hp: d.noise.hp, dur, attack: d.attack || .001});
  }
}

/* ---- the band roster (all data; add instruments here) ---- */
function buildRoster() {
  new HandDrum({id: 'bodhran', group: 'drums', pan: -.08, gain: .98, minGap: .05, voices: {
    dum: {f0: 78, sweep: 1.22, dur: .42, slap: .3, slapF: 380,
      partials: [[1,1,1],[1.59,.42,.45],[2.14,.2,.3],[2.65,.09,.22]]},
    tek: (t, v, i) => { noiseHitTo(i.out, t, v * .6, {f: 1500, q: 1.4, dur: .045, hp: 600}); pingTo(i.out, t, 168, v * .22, .06); },
    ka: (t, v, i) => i._play(t, 'tek', v * .6),
  }});
  new HandDrum({id: 'darbuka', group: 'drums', pan: -.06, gain: .98, minGap: .038, voices: {
    dum: {f0: 96, sweep: 1.18, dur: .26, slap: .22, slapF: 620,
      partials: [[1,1,1],[1.7,.35,.4],[2.4,.14,.26]]},
    tek: (t, v, i) => { noiseHitTo(i.out, t, v * .55, {f: 4600, q: 2, dur: .042, hp: 2800}); pingTo(i.out, t, 720, v * .16, .045); },
    ka: (t, v, i) => noiseHitTo(i.out, t, v * .42, {f: 3600, q: 2.2, dur: .03, hp: 2400}),
    fingerHi: (t, v, i) => { noiseHitTo(i.out, t, v * .5, {f: 3800, q: 2, dur: .025, hp: 2400}); pingTo(i.out, t, 880, v * .12, .03); },
    fingerLo: (t, v, i) => { noiseHitTo(i.out, t, v * .4, {f: 2600, q: 2, dur: .028, hp: 1600}); pingTo(i.out, t, 560, v * .14, .035); },
  }});
  new HandDrum({id: 'bongos', group: 'drums', pan: .22, gain: .9, minGap: .042, voices: {
    hi: {f0: 208, sweep: 1.12, dur: .16, slap: .2, slapF: 950,
      partials: [[1,1,1],[1.7,.45,.5],[2.4,.2,.35]]},
    lo: {f0: 128, sweep: 1.14, dur: .2, slap: .15, slapF: 700,
      partials: [[1,1,1],[1.6,.4,.5],[2.2,.18,.32]]},
    fingerHi: {f0: 215, sweep: 1.06, dur: .09, slap: .4, slapF: 1500,
      partials: [[1,.6,.7],[1.7,1,.55],[2.4,.5,.4]]},
    fingerLo: {f0: 132, sweep: 1.08, dur: .11, slap: .3, slapF: 1100,
      partials: [[1,.8,.7],[1.6,.9,.5],[2.2,.4,.35]]},
    /* aliases so bongos can stand in as the lead drum */
    dum: {f0: 120, sweep: 1.16, dur: .22, slap: .2, slapF: 750,
      partials: [[1,1,1],[1.6,.42,.5],[2.2,.2,.32]]},
    tek: {f0: 210, sweep: 1.1, dur: .13, slap: .3, slapF: 1000,
      partials: [[1,.9,.8],[1.7,.6,.5],[2.4,.25,.35]]},
    ka: (t, v, i) => i._play(t, 'fingerHi', v * .8),
  }});
  new HandDrum({id: 'crowd', group: 'drums', pan: -.05, gain: .98, minGap: .09, voices: {
    stomp: (t, v, i) => { membraneTo(i.out, t, v * 1.15, {f0: 56, sweep: 1.28, dur: .4, slap: 0,
        partials: [[1,1,1],[1.52,.28,.35]]});
      noiseHitTo(i.out, t, v * .35, {f: 220, q: 2, dur: .04}); noiseHitTo(i.out, t, v * .28, {f: 130, q: .8, dur: .07}); },
    clap: (t, v, i) => { for (const dt of [0, .009, .019]) noiseHitTo(i.out, t + dt, v * .3, {f: 1150, q: 1.1, dur: .028, hp: 500});
      noiseHitTo(i.out, t + .026, v * .4, {f: 1050, q: .9, dur: .1, hp: 400}); },
  }});
  new Jingle({id: 'tambourine', group: 'jingle', pan: .28, gain: .32,
    partials: [[5200,.22],[6300,.2],[7450,.16],[8600,.12]],
    noise: {f: 6800, q: 1.2, hp: 3800, g: .55}, closedDur: .08, openDur: .3});
  new Jingle({id: 'riq', group: 'jingle', pan: .28, gain: .32,
    partials: [[4800,.24],[6100,.2],[7000,.16],[8300,.12]],
    noise: {f: 6000, q: 1.4, hp: 3400, g: .5}, closedDur: .07, openDur: .28});
  /* the "tss": soft-attack silver shimmer, played sparse on backbeats */
  new Jingle({id: 'silver', group: 'jingle', pan: .32, gain: .3,
    partials: [[6800,.18],[7900,.16],[9200,.13],[10500,.1]],
    noise: {f: 8600, q: .8, hp: 5200, g: .5}, closedDur: .14, openDur: .55, attack: .004});
  new Jingle({id: 'shaker', group: 'jingle', pan: -.3, gain: .28,
    partials: [], noise: {f: 4200, q: 1.4, hp: 2200, g: .6}, closedDur: .06, openDur: .12, attack: .014});
  new Strings({id: 'lute', group: 'strings', pan: .12, gain: .58,
    ks: {bright: .6, damp: .9962, pick: .18, dur: 1.7, detune: 2.4, layers: 2},
    body: [{f: 200, q: 1.1, g: 3.5},{f: 420, q: 1.3, g: 2},{f: 2400, q: 1.2, g: 2.5}]});
  new Strings({id: 'harp', group: 'strings', pan: .08, gain: .58,
    ks: {bright: .82, damp: .9974, pick: .1, dur: 2.4, detune: 1.5, layers: 2},
    body: [{f: 320, q: 1, g: 2.5},{f: 2800, q: 1.5, g: 2}]});
  new Strings({id: 'oud', group: 'strings', pan: .1, gain: .54,
    ks: {bright: .45, damp: .9945, pick: .3, dur: 1.2, detune: 3.2, layers: 2},
    body: [{f: 150, q: 1.2, g: 3},{f: 1800, q: 1.6, g: 2.5}]});
  new Strings({id: 'bassViol', group: 'bass', pan: 0, gain: .5, warmth: true, softAttack: .012,
    ks: {bright: .22, damp: .9962, pick: .45, dur: 1.3, detune: 0, layers: 1},
    body: [{f: 95, q: 1, g: 2}],
    thock: {f: 170, q: 2, dur: .014, g: .3}});
  new Bowed({id: 'fiddle', group: 'fiddle', pan: -.18, gain: .5, attack: .18, release: .4});
  new Bowed({id: 'accordion', group: 'air', pan: .15, gain: .46, attack: .12, release: .3});
  new Instrument({id: 'drone', group: 'drone', pan: -.14, gain: .4});
  new Instrument({id: 'pad', group: 'air', pan: .1, gain: .07});
  new Instrument({id: 'hearth', group: 'hearth', pan: .3, gain: .5});
}

export function applyReverb(when) {
  if (!verbGain) return;
  verbGain.gain.setTargetAtTime(STYLES[state.styleId].reverb * state.mix.reverb, when ?? AC.currentTime, .25);
}
export function applyMix() {
  if (!AC) return;
  const now = AC.currentTime;
  for (const inst of Object.values(INSTRUMENTS)) {
    if (!inst._gain) continue;
    inst._gain.gain.setTargetAtTime(inst.def.gain * (state.mix[inst.def.group] ?? 1), now, .05);
    if (inst._warmth) inst._warmth.frequency.setTargetAtTime(state.mix.warmth, now, .05);
  }
  applyReverb();
}

/* ================= generators ================= */
/* melodic memory across bars (a plucked line, a bowed countermelody) */
const melState = {};
export function resetMel() { for (const k in melState) delete melState[k]; }

/* scale-degree -> MIDI in a given mode, base octave anchored on the tonic */
function degToMidi(deg, tonicPc, modeKey, baseMidi) {
  const iv = MODES[modeKey].iv, N = iv.length;
  const oct = Math.floor(deg / N), idx = ((deg % N) + N) % N;
  return baseMidi + tonicPc + oct * 12 + iv[idx];
}
/* chord tones as scale degrees (triad built on the chord's scale degree) */
function chordDegrees(chordDeg) { return [chordDeg, chordDeg + 2, chordDeg + 4]; }
function nearestChordTone(deg, chordDeg, N) {
  const tones = chordDegrees(chordDeg);
  let best = deg, bd = 99;
  for (const cd of tones) for (let o = -2; o <= 2; o++) {
    const cand = cd + o * N, d = Math.abs(cand - deg);
    if (d < bd) { bd = d; best = cand; }
  }
  return best;
}

export const GENERATORS = {
  /* "hands on bongos": quiet finger taps between the timekeeper's accents —
     one phrase per section, repeated like a real player grooving on a lick */
  fingerTexture: {mode: 'section', fn(ctx, part) {
    const ev = [];
    const density = (part.density ?? .5) * (state.mix.texture ?? 1) * lerp(.35, 1.25, conductor.intensity);
    let last = -9;
    for (let s = 0; s < ctx.stepsPerBar; s++) {
      let p = density * (s % ctx.stepsPerBeat === 0 ? .3 : .72);
      if (ctx.accents.has(s)) p *= .12;
      else if (ctx.occupied.has(s)) p *= .35;
      if (last === s - 1) p *= .5;
      if (Math.random() >= p) continue;
      last = s;
      const hi = Math.random() < .62;
      let vel = rand(.13, .3);
      if (ctx.isFill && s > ctx.stepsPerBar - 4) vel += rand(.05, .22);
      ev.push({step: s, voice: hi ? 'fingerHi' : 'fingerLo', vel});
      if (Math.random() < .08 && !ctx.occupied.has(s + 1) && !ctx.accents.has(s + 1))
        ev.push({step: s, off: .5, voice: hi ? 'fingerLo' : 'fingerHi', vel: rand(.09, .18)});
    }
    return ev;
  }},
  /* the croony voice: one long bowed tone per bar (chord root, the fifth
     every 4th bar); a root+fifth double-stop during the hush */
  bowedLine: {mode: 'bar', fn(ctx) {
    const ev = [];
    const off = (ctx.bar % 4 === 3) ? 7 : 0;
    ev.push({step: 0, chordOff: off, durSteps: ctx.stepsPerBar, vel: .32});
    if (ctx.passage === 'break')
      ev.push({step: 0, off: .3, chordOff: off === 7 ? 0 : 7, durSteps: ctx.stepsPerBar, vel: .24});
    return ev;
  }},
  /* the medieval string melody: a flowing modal line — stepwise motion with
     a phrase arc, chord tones on strong beats, the modal color notes leaned
     on, and celtic grace-note ornaments. This is what makes it sound "old"
     rather than like block backing. */
  melody: {mode: 'bar', fn(ctx, part) {
    const id = 'mel:' + (part.inst || 'x');
    const s = melState[id] ??= {deg: 0, phraseBar: 0};
    const N = MODES[ctx.mode].iv.length;
    const base = part.base ?? 60;               /* tonic register (C4-ish) */
    const midi = d => degToMidi(d, ctx.tonic, ctx.mode, base);
    const cdeg = ctx.chordDeg;
    /* modal colour notes to lean on: b7 (deg 6) always, +natural-6 (deg 5) in Dorian/Mixolydian */
    const colour = (ctx.mode === 'dorian' || ctx.mode === 'mixolydian') ? [5, 6] : [6];
    const R6 = [[0,2,4,6,8,10],[0,3,4,6,9,10],[0,2,3,5,6,8,9,11],[0,2,4,5,6,8,10,11],[0,3,6,8,9,11]];
    const R4 = [[0,2,4,6,8,10,12,14],[0,3,4,6,8,11,12,14],[0,2,4,6,8,10,12,13,14],[0,4,6,8,10,12,14],[0,2,3,4,8,10,11,12]];
    let rhythm = choice(ctx.stepsPerBeat === 6 ? R6 : R4);
    /* density knob (Forge): thin the line, always keeping the strong beats */
    const dens = part.density;
    if (dens != null && dens < 1)
      rhythm = rhythm.filter(st => st % ctx.stepsPerBeat === 0 || Math.random() < dens);
    const rising = s.phraseBar < 2;
    const lastIdx = rhythm.length - 1;
    const ev = [];
    for (let k = 0; k < rhythm.length; k++) {
      const step = rhythm[k];
      const strong = step % ctx.stepsPerBeat === 0;
      const resolving = s.phraseBar === 3 && k >= rhythm.length - 2;
      if (resolving) {
        /* land the phrase: walk toward the tonic/nearest chord tone */
        if (k === lastIdx) s.deg = nearestChordTone(0, cdeg, N);
        else s.deg += Math.sign(0 - s.deg) || 0;
      } else if (strong) {
        s.deg = nearestChordTone(s.deg, cdeg, N);
      } else {
        const r = Math.random();
        let stepMove = r < .58 ? (rising ? 1 : -1)
          : r < .8 ? (rising ? -1 : 1)
          : r < .9 ? (rising ? 2 : -2)
          : 0;
        s.deg += stepMove;
        /* lean toward a colour note now and then for the modal flavour */
        if (Math.random() < .22) {
          const target = choice(colour);
          const here = ((s.deg % N) + N) % N;
          if (here !== target) s.deg += Math.sign(target - here);
        }
      }
      /* keep it under the whistle: reflect within roughly D4..D5 */
      if (s.deg > 7) s.deg = 7 - (s.deg - 7);
      if (s.deg < -3) s.deg = -3 + (-3 - s.deg);
      s.deg = clamp(s.deg, -4, 8);
      const vel = (strong ? .72 : .5) * (.85 + Math.random() * .3);
      /* grace-note ornament: a rare quick step above, just before a strong
         note — a occasional flourish, not a constant tic */
      if (strong && !resolving && !s.gracedLast && Math.random() < .05) {
        ev.push({step, off: -.38, midi: midi(s.deg + 1), vel: vel * .45});
        s.gracedLast = true;
      } else s.gracedLast = false;
      ev.push({step, midi: midi(s.deg), vel});
    }
    s.phraseBar = (s.phraseBar + 1) % 4;
    return ev;
  }},
  /* the fiddle as a SECOND voice, not a drone: one slow sustained chord tone
     per bar, stepping to the next — a countermelody weaving under the lead */
  fiddleLine: {mode: 'bar', fn(ctx) {
    const s = melState['fid'] ??= {deg: 4};
    const N = MODES[ctx.mode].iv.length;
    const base = 48; /* base must be a multiple of 12 so deg 0 == the tonic */
    const midi = d => degToMidi(clamp(d, 3, 9), ctx.tonic, ctx.mode, base);
    const drift = Math.random() < .55 ? (Math.random() < .5 ? 1 : -1) : 0;
    s.deg = clamp(nearestChordTone(s.deg + drift, ctx.chordDeg, N), 3, 9);
    const ev = [{step: 0, midi: midi(s.deg), durSteps: ctx.stepsPerBar, vel: .3}];
    if (Math.random() < .4) /* move to another chord tone mid-bar for motion */
      ev.push({step: Math.floor(ctx.stepsPerBar / 2), midi: midi(nearestChordTone(s.deg + 2, ctx.chordDeg, N)),
        durSteps: Math.ceil(ctx.stepsPerBar / 2), vel: .26});
    return ev;
  }},
  /* the bellows: one wheezy chord swell per bar (root, fifth, octave) */
  squeeze: {mode: 'bar', fn(ctx) {
    return [0, 7, 12].map((o, i) =>
      ({step: 0, off: i * .05, chordOff: o, durSteps: ctx.stepsPerBar, vel: .3 - i * .04}));
  }},
  /* the "tss": scarcity is the signifier — one per bar at most, every other
     bar in 6/8; opens up only on the last bar of each section */
  backbeatTss: {mode: 'bar', fn(ctx) {
    const ev = []; const spb = ctx.stepsPerBeat, bpb = ctx.beatsPerBar;
    const vel = .5 * lerp(.85, 1.15, conductor.intensity);
    if (bpb === 2) { if (ctx.bar % 2 === 0) ev.push({step: spb, open: ctx.isFill, vel}); }
    else ev.push({step: 2 * spb, open: ctx.isFill, vel});
    return ev;
  }},
};
validateStyles(GENERATORS);

/* ================= drone / pad / hearth ================= */
let droneNodes = null;
function startDrone(rootMidi, level, when) {
  stopDrone(when, state.blend ? 1.2 : .15);
  if (level <= 0) return;
  const t = when ?? AC.currentTime;
  const dest = INSTRUMENTS.drone.ensureBus();
  const out = AC.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(level, t + (state.blend ? 2 : .25));
  const filt = AC.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 720; filt.Q.value = .7;
  const lfo = AC.createOscillator(); lfo.frequency.value = .07;
  const lfoG = AC.createGain(); lfoG.gain.value = 150;
  lfo.connect(lfoG); lfoG.connect(filt.frequency);
  filt.connect(out); out.connect(dest);
  const parts = [[rootMidi, -5, 1],[rootMidi, 5, 1],[rootMidi + 7, 2, .55]];
  const oscs = [lfo];
  for (const [m, det, g] of parts) {
    const o = AC.createOscillator(); o.type = 'sawtooth';
    o.frequency.value = mtof(m); o.detune.value = det;
    const og = AC.createGain(); og.gain.value = g * .33;
    o.connect(og); og.connect(filt); o.start(t); oscs.push(o);
  }
  lfo.start(t);
  droneNodes = {oscs, out};
}
function stopDrone(when, fade = 0.8) {
  if (!droneNodes) return;
  const t = when ?? AC.currentTime;
  const {oscs, out} = droneNodes; droneNodes = null;
  out.gain.cancelScheduledValues(t);
  out.gain.setTargetAtTime(0, t, fade / 3);
  for (const o of oscs) { try { o.stop(t + fade * 2); } catch (e) {} }
}
let padNodes = null;
function padChord(chord, level, t) {
  if (padNodes) {
    const old = padNodes; padNodes = null;
    old.out.gain.cancelScheduledValues(t);
    old.out.gain.setTargetAtTime(0, t, state.blend ? .35 : .1);
    for (const o of old.oscs) { try { o.stop(t + 2); } catch (e) {} }
  }
  if (level <= 0) return;
  const dest = INSTRUMENTS.pad.ensureBus();
  const out = AC.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(1, t + (state.blend ? .9 : .2));
  const filt = AC.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 950; filt.Q.value = .5;
  filt.connect(out); out.connect(dest);
  const oscs = [];
  for (const off of [0, 7, 12]) {
    const o = AC.createOscillator(); o.type = 'sawtooth';
    o.frequency.value = mtof(chord.rootMidi + off); o.detune.value = rand(-5, 5);
    const og = AC.createGain(); og.gain.value = .3;
    o.connect(og); og.connect(filt); o.start(t); oscs.push(o);
  }
  padNodes = {oscs, out};
}
let hearth = null;
export function setHearth(onNow) {
  if (onNow && !hearth) {
    initAudio(); AC.resume();
    const dest = INSTRUMENTS.hearth.ensureBus();
    const t = AC.currentTime;
    const src = AC.createBufferSource();
    const sr = AC.sampleRate, len = sr * 2;
    const b = AC.createBuffer(1, len, sr), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + .02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2; }
    src.buffer = b; src.loop = true;
    const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 240;
    const g = AC.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.06, t + 1.2);
    src.connect(f); f.connect(g); g.connect(dest); src.start(t);
    const timer = setInterval(() => {
      if (!hearth) return;
      if (Math.random() < .75)
        noiseHitTo(dest, AC.currentTime + rand(.01, .12), rand(.05, .3),
          {f: rand(500, 2600), q: rand(6, 14), dur: rand(.015, .05)});
    }, 140);
    hearth = {src, g, timer};
  } else if (!onNow && hearth) {
    const {src, g, timer} = hearth; hearth = null;
    clearInterval(timer);
    g.gain.setTargetAtTime(0, AC.currentTime, .3);
    try { src.stop(AC.currentTime + 1.2); } catch (e) {}
  }
}

/* ================= arrangement =================
   The song arc: the band moves through passages, one audible change per
   passage (a layer in, a layer out, or a handoff). After the composed tag
   it starts the next pass — endless play, song-shaped. Role lists gate
   which parts sound, on top of the user's toggles. */
const ARC = [
  {id: 'intro', sec: 'A', mBars: 4, label: 'intro',  roles: ['pluck', 'drone', 'pad', 'squeeze']},
  {id: 'A1',    sec: 'A', mBars: 8, label: 'verse',  roles: ['pluck', 'drone', 'pad', 'bass', 'drums']},
  {id: 'A2',    sec: 'A', mBars: 8, label: 'rise',   roles: ['pluck', 'drone', 'pad', 'bass', 'drums', 'texture', 'bowed']},
  {id: 'B1',    sec: 'B', mBars: 8, label: 'turn',   roles: ['pluck', 'drone', 'pad', 'bass', 'drums', 'texture', 'bowed', 'tss', 'jingle', 'squeeze']},
  {id: 'A3',    sec: 'A', mBars: 8, label: 'peak',   roles: 'all'},
  {id: 'break', sec: 'B', mBars: 4, label: 'hush',   roles: ['drone', 'pad', 'bowed', 'squeeze']},
  {id: 'final', sec: 'B', mBars: 8, label: 'finale', roles: 'all'},
  {id: 'tag',   sec: 'A', mBars: 0, label: 'tag',    roles: ['drums', 'pluck', 'bass', 'drone'], tag: true},
];
function passageLen(pass, sty) {
  /* two-beat bars (jigs, polka) are short — double their passages */
  return pass.tag ? 2 : pass.mBars * (sty.beatsPerBar === 2 ? 2 : 1);
}
function roleActive(pass, pname) {
  if (state.fullBand) return true; /* debug: whole band from bar one */
  return pass.roles === 'all' || pass.roles.includes(pname);
}

/* ================= sequencer ================= */
let timer = null;
export const beatQueue = [], chordQueue = [], passageQueue = [];
function pickPattern(variants) {
  const tot = variants.reduce((s, v) => s + v.w, 0);
  let r = Math.random() * tot;
  for (const v of variants) { r -= v.w; if (r <= 0) return v.s; }
  return variants[0].s;
}
function partOn(pname, part) {
  const t = state.toggles;
  if (pname === 'bowed') return t.fiddle;
  if (pname === 'squeeze') return t.pad;
  if (pname === 'pluck') return t.pluck; /* melodic pluck gens ride the Strings toggle */
  if (part.kind === 'drum' || pname === 'texture') return t.drums;
  if (part.kind === 'jingle' || pname === 'tss') return t.jingle;
  if (part.kind === 'harmony') return t.pluck;
  if (part.kind === 'bass') return t.bass;
  return true;
}
const hum = () => 1 + rand(-.13, .07) * state.mix.human;
function beginBar(when) {
  const st = state;
  if (st.pending.styleId !== undefined || st.pending.tonic !== undefined) {
    if (st.pending.styleId !== undefined && st.pending.styleId !== st.styleId) {
      st.styleId = st.pending.styleId; st.barIdx = 0;
      applyReverb(when);
    }
    if (st.pending.tonic !== undefined) st.tonic = st.pending.tonic;
    st.pending = {}; st.lastDrone = null; st.arc = null; /* new tune, fresh arc */
    resetMel();
  }
  const sty = STYLES[st.styleId];
  const stepsPerBar = sty.beatsPerBar * sty.stepsPerBeat;
  /* advance the song arc */
  if (!st.arc) { st.arc = {p: 0, bar: 0}; passageQueue.push({t: when, label: ARC[0].label}); }
  let pass = ARC[st.arc.p];
  if (st.arc.bar >= passageLen(pass, sty)) {
    st.arc.p = (st.arc.p + 1) % ARC.length;
    st.arc.bar = 0;
    pass = ARC[st.arc.p];
    passageQueue.push({t: when, label: pass.label});
  }
  const barInPass = st.arc.bar;
  st.arc.bar++;
  const plen = passageLen(pass, sty);
  const secChords = sty.sections[pass.sec] || sty.sections.A;
  const spec = pass.tag ? secChords[0] : secChords[barInPass % secChords.length];
  const nextSpec = pass.tag ? secChords[0] : secChords[(barInPass + 1) % secChords.length];
  const chord = makeChord(st.tonic, sty.mode, spec);
  const next = makeChord(st.tonic, sty.mode, nextSpec);
  const isFill = !pass.tag && (barInPass % secChords.length === secChords.length - 1);
  const isTransition = barInPass === plen - 1;
  const band = conductor.band();
  /* the band picks its groove once per passage-quarter and rides it —
     repetition is the accompanist's job; the flute owns the variation */
  const secKey = st.styleId + ':' + band + ':' + st.arc.p + ':' + Math.floor(barInPass / 4);
  if (st._secKey !== secKey) {
    st._secKey = secKey;
    st._secPats = {};
    for (const [pname, part] of Object.entries(sty.parts)) {
      if (part.kind === 'gen') continue;
      const variants = part.pat[band];
      if (variants && variants.length) st._secPats[pname] = pickPattern(variants);
    }
    const accents = new Set(), occupied = new Set();
    const dp = st._secPats.drums;
    if (dp) for (let i = 0; i < dp.length; i++) {
      const c = dp[i];
      if (c === '.') continue;
      occupied.add(i);
      if (c === c.toUpperCase()) accents.add(i);
    }
    st._secCtx = {stepsPerBar, stepsPerBeat: sty.stepsPerBeat, beatsPerBar: sty.beatsPerBar,
      accents, occupied, bar: st.barIdx, isFill: false};
    st._secGens = {};
    for (const [pname, part] of Object.entries(sty.parts)) {
      if (part.kind !== 'gen') continue;
      const g = GENERATORS[part.gen];
      if (g.mode !== 'section') continue;
      const byStep = {};
      for (const e of g.fn(st._secCtx, part)) (byStep[e.step] ??= []).push(e);
      st._secGens[pname] = byStep;
    }
  }
  const pats = {}, gens = {};
  if (pass.tag && !state.fullBand) {
    /* the composed ending: one unison stab, then a bar of ring-out */
    if (barInPass === 0) {
      const dots = '.'.repeat(stepsPerBar - 1);
      if (sty.parts.drums && partOn('drums', sty.parts.drums)) pats.drums = 'D' + dots;
      if (sty.parts.pluck && partOn('pluck', sty.parts.pluck)) pats.pluck = 'C' + dots;
      if (sty.parts.bass && partOn('bass', sty.parts.bass)) pats.bass = 'R' + dots;
    }
  } else {
    for (const [pname, part] of Object.entries(sty.parts)) {
      if (part.kind === 'gen' || !partOn(pname, part) || !roleActive(pass, pname)) continue;
      let s = st._secPats[pname];
      if (!s) continue;
      const fp = (part.kind === 'drum' ? .7 : .5) * st.mix.fills *
        lerp(.75, 1, conductor.intensity) * (isTransition ? 1.5 : .8);
      if (isFill && part.fills && Math.random() < Math.min(.95, fp)) s = choice(part.fills);
      pats[pname] = s;
    }
    const ctx = Object.assign({}, st._secCtx, {bar: st.barIdx, isFill, passage: pass.id,
      chordDeg: spec.d, tonic: st.tonic, mode: sty.mode});
    for (const [pname, part] of Object.entries(sty.parts)) {
      if (part.kind !== 'gen' || !partOn(pname, part) || !roleActive(pass, pname)) continue;
      const g = GENERATORS[part.gen];
      if (g.mode === 'section') { gens[pname] = st._secGens[pname] || {}; continue; }
      const byStep = {};
      for (const e of g.fn(ctx, part)) (byStep[e.step] ??= []).push(e);
      gens[pname] = byStep;
    }
  }
  st.curBar = {chord, next, pats, gens, sty, pass};
  /* drone follows the tonic, not the chord */
  const droneKey = st.tonic + ':' + st.styleId;
  const droneOn = state.toggles.drone && sty.drone > 0 && roleActive(pass, 'drone');
  if (droneOn && st.lastDrone !== droneKey) {
    const tonicChord = makeChord(st.tonic, sty.mode, {d: 0, q: '5'});
    startDrone(tonicChord.bass, sty.drone, when);
    st.lastDrone = droneKey;
  } else if (!droneOn && st.lastDrone) { stopDrone(when); st.lastDrone = null; }
  if (state.toggles.pad && sty.pad > 0 && roleActive(pass, 'pad')) {
    if (st.lastChordKey !== chord.key) { padChord(chord, sty.pad, when); st.lastChordKey = chord.key; }
  } else if (st.lastChordKey) { padChord(chord, 0, when); st.lastChordKey = null; }
  chordQueue.push({t: when, label: chord.label});
}
function swingOff(sib, sd, sty) {
  if (sty.stepsPerBeat === 6 && sty.lilt) {
    /* jig lilt: soft long-short eighth pairs inside each pulse — the middle
       and last eighths of the 3-group land a touch late */
    const pos = sib % 6, e = 2 * sd, s = sty.lilt * state.mix.swing;
    if (pos === 2) return s * e;
    if (pos === 4) return s * e * .4;
    return 0;
  }
  if (!sty.swing || sty.stepsPerBeat !== 4) return 0;
  const pos = sib % 4, e = 2 * sd, s = sty.swing * state.mix.swing;
  if (pos === 2) return s * e;
  if (pos === 1 || pos === 3) return s * e * .5;
  return 0;
}
function dispatchChar(part, ch, t, bar) {
  let instId = part.inst;
  if (part.kind === 'harmony' && state.voices.strings) instId = state.voices.strings;
  const inst = INSTRUMENTS[instId];
  const drive = .85 + conductor.intensity * .25; /* percussion leans into the room */
  if (part.kind === 'drum') {
    const m = DRUM_MAPS[part.map][ch];
    if (m) {
      let id = m[0];
      if (state.voices.drums && HAND_DRUMS.includes(id)) id = state.voices.drums;
      INSTRUMENTS[id].stroke(t, m[1], m[2] * drive * hum());
    }
  } else if (part.kind === 'jingle') {
    if (ch === 'X') inst.hit(t, .9 * drive * hum());
    else if (ch === 'x') inst.hit(t, .45 * drive * hum());
    else if (ch === 'O') inst.hit(t, .8 * drive * hum(), {open: true});
  } else if (part.kind === 'harmony') {
    const c = bar.chord;
    if (ch === 'C') inst.strum(t, c, .8 * hum(), {strong: true});
    else if (ch === 'c') inst.strum(t, c, .42 * hum(), {count: 2, top: true});
    else if (ch === 'u') inst.strum(t, c, .5 * hum(), {dir: 'up'});
    else if (ch === 'r') inst.pluck(t, c.rootMidi, .5 * hum());
    else if (ch === 'B') inst.pluck(t, c.rootMidi, .85 * hum());
    else if (ch >= '0' && ch <= '5') {
      const idx = +ch % c.arp.length;
      inst.pluck(t, c.rootMidi + c.arp[idx], .6 * hum());
    }
  } else if (part.kind === 'bass') {
    const c = bar.chord;
    if (ch === 'R') inst.pluck(t, c.bass, .85 * hum());
    else if (ch === 'r') inst.pluck(t, c.bass, .5 * hum());
    else if (ch === '5') inst.pluck(t, c.bass + 7, .7 * hum());
    else if (ch === '8') inst.pluck(t, c.bass + 12, .7 * hum());
    else if (ch === 'P') {
      const n = passingNote(state.tonic, bar.sty.mode, bar.next.bass, c.bass);
      inst.pluck(t, n, .6 * hum());
    }
  }
}
const JITTER = {drum: .003, jingle: .004, harmony: .006, bass: .004, gen: .005};
function scheduleStep(when) {
  const st = state;
  if (st.stepInBar === 0) beginBar(when);
  const bar = st.curBar, sty = bar.sty;
  const spb = sty.beatsPerBar * sty.stepsPerBeat;
  const sw = swingOff(st.stepInBar, st.stepDur, sty);
  for (const [pname, pat] of Object.entries(bar.pats)) {
    const ch = pat[st.stepInBar];
    if (!ch || ch === '.') continue;
    const part = sty.parts[pname];
    const t = when + sw + rand(-1, 1) * (JITTER[part.kind] || .004) * st.mix.human * (sty.rough || 1);
    dispatchChar(part, ch, Math.max(t, AC.currentTime + .005), bar);
  }
  for (const [pname, byStep] of Object.entries(bar.gens)) {
    const evs = byStep[st.stepInBar];
    if (!evs) continue;
    const part = sty.parts[pname];
    let instId = part.inst;
    if (HARMONY_INSTS.includes(instId) && state.voices.strings) instId = state.voices.strings;
    const inst = INSTRUMENTS[instId];
    for (const e of evs) {
      let t = when + sw + (e.off || 0) * st.stepDur + rand(-1, 1) * JITTER.gen * st.mix.human * (sty.rough || 1);
      t = Math.max(t, AC.currentTime + .005);
      if (inst instanceof HandDrum) inst.stroke(t, e.voice, e.vel * hum());
      else if (inst instanceof Bowed) {
        const midi = e.midi != null ? e.midi : bar.chord.rootMidi + (e.chordOff || 0) + (part.octave || 0);
        inst.bow(t, midi, (e.durSteps || 1) * st.stepDur, e.vel * hum());
      }
      else if (inst instanceof Strings) inst.pluck(t, e.midi, e.vel * hum());
      else if (inst instanceof Jingle) inst.hit(t, e.vel * hum(), {open: e.open});
    }
  }
  if (st.stepInBar % sty.stepsPerBeat === 0) beatQueue.push(when);
  st.stepInBar++;
  if (st.stepInBar >= spb) { st.stepInBar = 0; st.barIdx++; }
}
function tick() {
  const st = state;
  const look = document.hidden ? 1.6 : 0.3;
  while (st.playing && st.nextTime < AC.currentTime + look) {
    const sty = STYLES[st.pending.styleId !== undefined && st.stepInBar === 0 ? st.pending.styleId : st.styleId];
    /* ease tempo toward target, 6 BPM per second; intensity flows alongside,
       and an excited band pushes the pulse a touch (±2%) like real players */
    st.stepDur = 60 / (st.tempo * (1 + (conductor.intensity - .55) * .05) * sty.stepsPerBeat);
    scheduleStep(st.nextTime);
    st.nextTime += st.stepDur;
    st.tempo += clamp(st.tempoTarget - st.tempo, -6 * st.stepDur, 6 * st.stepDur);
    conductor.advance(st.stepDur);
  }
}
let wakeLock = null;
async function grabWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.playing && !wakeLock) grabWakeLock();
});
export function play() {
  initAudio(); AC.resume();
  const st = state;
  st.playing = true; st.stepInBar = 0; st.barIdx = 0; st.lastChordKey = null; st.lastDrone = null;
  st.arc = null; st._secKey = null; resetMel();
  passageQueue.length = 0;
  st.tempo = st.tempoTarget;
  st.nextTime = AC.currentTime + .1;
  applyReverb();
  timer = setInterval(tick, 40); tick();
  grabWakeLock();
  emit('transport', {playing: true, styleName: STYLES[st.styleId].name});
}
export function stop() {
  const st = state;
  st.playing = false;
  clearInterval(timer); timer = null;
  stopDrone(); if (padNodes) { padChord({rootMidi: 0}, 0, AC.currentTime); } st.lastChordKey = null; st.lastDrone = null;
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  beatQueue.length = 0; chordQueue.length = 0; passageQueue.length = 0;
  emit('transport', {playing: false});
}
export function togglePlay() { state.playing ? stop() : play(); }
