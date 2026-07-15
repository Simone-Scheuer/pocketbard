import {clamp} from './util.js';
import {STYLES} from './styles.js';

export const MIX_DEFAULTS = {
  drums: 1, jingle: 1, strings: 1, fiddle: 1, bass: 1, drone: 1, air: 1, texture: 1,
  reverb: 1, warmth: 760, swing: 1, fills: 1, human: 1,
};

export const state = {
  playing: false, styleId: 'tavern_jig', tonic: 2, energy: 1,
  tempo: 108, tempoTarget: 108, volume: .8,
  toggles: {drums: true, jingle: true, pluck: true, fiddle: true, bass: true, drone: true, pad: true, hearth: false},
  voices: {strings: null, drums: null}, /* null = the tune's own pick */
  myKey: null, /* player's instrument key (pc); tunes re-tonic to fit it */
  blend: false, /* true = slow crossfades on key/tune changes; false = tight */
  fullBand: false, /* debug: skip the song build-up, all parts from bar one */
  mix: Object.assign({}, MIX_DEFAULTS),
  customs: [], /* saved "keep this sound" cards: {id,name,base,tonic,...} */
  stepInBar: 0, barIdx: 0, nextTime: 0, stepDur: 0,
  pending: {}, curBar: null, lastChordKey: null, lastDrone: null,
};

try {
  const saved = JSON.parse(localStorage.getItem('pocketbard') || 'null');
  if (saved) {
    Object.assign(state.toggles, saved.toggles || {});
    if (saved.mix) for (const k of Object.keys(MIX_DEFAULTS))
      if (typeof saved.mix[k] === 'number') state.mix[k] = saved.mix[k];
    if (saved.styleId && STYLES[saved.styleId]) state.styleId = saved.styleId;
    if (Number.isInteger(saved.tonic)) state.tonic = saved.tonic;
    if (saved.tempoTarget) state.tempo = state.tempoTarget = saved.tempoTarget;
    if (saved.energy != null) state.energy = saved.energy;
    if (saved.voices) {
      if (['lute','harp','oud'].includes(saved.voices.strings)) state.voices.strings = saved.voices.strings;
      if (['bodhran','darbuka','bongos'].includes(saved.voices.drums)) state.voices.drums = saved.voices.drums;
    }
    if (typeof saved.intensity === 'number') state._li = clamp(saved.intensity, 0, 1);
    if (Number.isInteger(saved.myKey)) state.myKey = saved.myKey;
    if (Array.isArray(saved.customs))
      state.customs = saved.customs.filter(c => c && c.id && STYLES[c.base]).slice(0, 20);
    if (typeof saved.blend === 'boolean') state.blend = saved.blend;
    if (typeof saved.fullBand === 'boolean') state.fullBand = saved.fullBand;
    if (saved.volume != null) state.volume = saved.volume;
  }
} catch (e) {}

let getIntensityTarget = () => .55;
export function bindPersist(fn) { getIntensityTarget = fn; }

export function persist() {
  try {
    localStorage.setItem('pocketbard', JSON.stringify({
      styleId: state.styleId, tonic: state.tonic, tempoTarget: state.tempoTarget,
      energy: state.energy, intensity: getIntensityTarget(), blend: state.blend,
      fullBand: state.fullBand,
      myKey: state.myKey, customs: state.customs,
      volume: state.volume, toggles: state.toggles, voices: state.voices, mix: state.mix,
    }));
  } catch (e) {}
}
