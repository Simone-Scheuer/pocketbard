export const NOTE_NAMES = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];

export const MODES = {
  major: {iv: [0,2,4,5,7,9,11], label: 'Major'},
  mixolydian: {iv: [0,2,4,5,7,9,10], label: 'Mixolydian'},
  dorian: {iv: [0,2,3,5,7,9,10], label: 'Dorian'},
  aeolian: {iv: [0,2,3,5,7,8,10], label: 'Minor'},
  phrygian: {iv: [0,1,3,5,7,8,10], label: 'Phrygian'},
  hijaz: {iv: [0,1,4,5,7,8,10], label: 'Hijaz'},
};

const WHISTLE_ORDER = [2,0,7,9,10,3,5,4,11,6,1,8];

export function whistleHint(tonicPc, modeKey) {
  const scale = MODES[modeKey].iv.map(i => (tonicPc + i) % 12);
  for (const w of WHISTLE_ORDER) {
    const set = new Set([0,2,4,5,7,9,10,11].map(i => (w + i) % 12));
    if (scale.every(pc => set.has(pc))) return 'sits well on a ' + NOTE_NAMES[w] + ' whistle';
  }
  return 'off the whistle scale — half-hole, or pick another key';
}

export function makeChord(tonicPc, modeKey, spec) {
  const rootPc = (tonicPc + MODES[modeKey].iv[spec.d]) % 12;
  const rootMidi = 50 + ((rootPc + 10) % 12); /* anchor D3=50 */
  const third = spec.q === 'M' ? 4 : spec.q === 'm' ? 3 : null;
  const strum = third === null ? [0,7,12] : [0,7,12,12+third];
  const arp = third === null ? [0,7,12,19,24,31] : [0,7,12,12+third,19,24];
  const label = NOTE_NAMES[rootPc] + (spec.q === 'm' ? 'm' : spec.q === '5' ? '5' : '');
  return {rootMidi, bass: rootMidi - 12, strum, arp, q: spec.q, label, key: rootPc + ':' + spec.q};
}

/* best tonic for a style's mode on an instrument in key wPc:
   prefer scales fully inside the instrument's major scale, then ones that
   only need the cross-fingered flat-7, then closest fit; break ties by how
   naturally the tonic sits on the instrument (unison, fifth, second, ...) */
export function optimalTonic(modeKey, wPc) {
  const iv = MODES[modeKey].iv;
  const strict = new Set([0,2,4,5,7,9,11].map(i => (wPc + i) % 12));
  const loose = new Set([...strict, (wPc + 10) % 12]);
  const pref = [0,7,2,9,4,5,11,10,3,8,1,6];
  let best = null;
  for (let pi = 0; pi < pref.length; pi++) {
    const t = (wPc + pref[pi]) % 12;
    const scale = iv.map(i => (t + i) % 12);
    const mLoose = scale.filter(pc => !loose.has(pc)).length;
    const mStrict = scale.filter(pc => !strict.has(pc)).length;
    if (!best || mLoose < best.mLoose || (mLoose === best.mLoose && mStrict < best.mStrict))
      best = {t, mLoose, mStrict};
  }
  return best.t;
}

export function passingNote(tonicPc, modeKey, target, from) {
  const pcs = new Set(MODES[modeKey].iv.map(i => (tonicPc + i) % 12));
  if (target > from) {
    for (const c of [target-1, target-2, target-3]) if (pcs.has(((c % 12) + 12) % 12)) return c;
  } else {
    for (const c of [target+2, target+1, target+3]) if (pcs.has(((c % 12) + 12) % 12)) return c;
  }
  return target;
}
