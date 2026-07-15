/* SampleLibrary: the bridge from synthesis to real acoustic sound.
   Ship the app with zero samples and everything synthesizes as before;
   drop audio files into public/samples/ + list them in manifest.json and
   instruments pick them up automatically, per hit or per note.

   manifest.json shape:
   {
     "hits":  { "bodhran.dum": ["frame/a.wav", "frame/b.wav"], ... },
     "notes": { "lute": { "48": ["lute/c3.wav"], "55": ["lute/g3.wav"] } },
     "gains": { "bodhran.dum": 0.9 }        // musical level per articulation
   }
   Hits: round-robin variants per named articulation.
   Notes: sparse chromatic map; nearest sample within ±4 semitones is
   repitched via playbackRate.
   Every buffer is lead-silence-trimmed (so transients land on the grid)
   and peak-normalized (so `gains` are musical decisions, not file trivia). */
export class SampleLibrary {
  constructor() {
    this.hitMap = new Map();    // "inst.artic" -> [AudioBuffer]
    this.noteMap = new Map();   // "inst" -> [{midi, buffers}] sorted
    this.gains = {};
    this.ready = false;
  }

  async load(ctx, baseUrl = 'samples/') {
    let manifest = null;
    try {
      const res = await fetch(baseUrl + 'manifest.json');
      if (res.ok) manifest = await res.json();
    } catch (e) {}
    if (!manifest && import.meta.env.MODE === 'artifact') {
      /* single-file build: samples travel inside the bundle as data URIs */
      try {
        manifest = (await import('./samples-inline.js')).default;
        baseUrl = '';
      } catch (e) {}
    }
    if (!manifest) return; /* no samples shipped: synthesis covers everything */
    this.gains = manifest.gains || {};

    const dec = async file => {
      try {
        const r = await fetch(baseUrl + file);
        if (!r.ok) return null;
        const buf = await ctx.decodeAudioData(await r.arrayBuffer());
        return prep(ctx, buf);
      } catch (e) { return null; }
    };

    const jobs = [];
    for (const [key, files] of Object.entries(manifest.hits || {})) {
      jobs.push((async () => {
        const bufs = (await Promise.all(files.map(dec))).filter(Boolean);
        if (bufs.length) this.hitMap.set(key, bufs);
      })());
    }
    for (const [inst, byMidi] of Object.entries(manifest.notes || {})) {
      jobs.push((async () => {
        const entries = [];
        for (const [midi, files] of Object.entries(byMidi)) {
          const bufs = (await Promise.all(files.map(dec))).filter(Boolean);
          if (bufs.length) entries.push({midi: +midi, buffers: bufs});
        }
        if (entries.length) this.noteMap.set(inst, entries.sort((a, b) => a.midi - b.midi));
      })());
    }
    await Promise.all(jobs);
    this.ready = true;
  }

  hit(inst, artic) {
    const a = this.hitMap.get(inst + '.' + artic);
    return a ? a[Math.floor(Math.random() * a.length)] : null;
  }
  gain(inst, artic) { return this.gains[inst + '.' + artic] ?? 1; }
  noteGain(inst) { return this.gains[inst + '.notes'] ?? 1; }

  note(inst, midi) {
    const entries = this.noteMap.get(inst);
    if (!entries) return null;
    let best = null, bestD = 5;
    for (const e of entries) {
      const d = Math.abs(e.midi - midi);
      if (d < bestD) { best = e; bestD = d; }
    }
    if (!best) return null;
    const buffer = best.buffers[Math.floor(Math.random() * best.buffers.length)];
    return {buffer, rate: Math.pow(2, (midi - best.midi) / 12)};
  }
}

/* trim leading silence (keeping a 1.5 ms pre-roll) and normalize peak */
function prep(ctx, buf) {
  const ch0 = buf.getChannelData(0);
  const thresh = .004;
  let start = 0;
  for (let i = 0; i < ch0.length; i++) if (Math.abs(ch0[i]) > thresh) { start = i; break; }
  start = Math.max(0, start - Math.floor(buf.sampleRate * .0015));
  const len = buf.length - start;
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    for (let i = start; i < buf.length; i++) peak = Math.max(peak, Math.abs(src[i]));
  }
  const g = .9 / (peak || 1);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < len; i++) dst[i] = src[start + i] * g;
  }
  return out;
}
