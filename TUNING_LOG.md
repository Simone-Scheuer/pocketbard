# Tuning log

## Open backlog (from Simone's 2026-07-15 listening pass — fix in batches, not piecemeal)

- **V · Understated mode**: ref Justin Bell "The Fox and the Farmer" (PoE) —
  "a jingle and a tap in the background". Partially served by the new arc's
  intro/verse passages; a dedicated Understated flavor still open.

## The Batch (2026-07-15, all four items shipped)

- 2026-07-15 · G · SHANTY JAUNTY PASS: aeolian→DORIAN (Drunken Sailor bones,
  i-bVII vamp), 84→104, bouncier drums/pluck chops, rough 1.6→1.4 · "should be
  really jaunty and yo ho ho, it's slow and moody"
- 2026-07-15 · A · fiddle added to Tavern Jig, Festival Jig, Céilí Dance so the
  arc's rise/turn passages actually add an audible layer · "stays at that low
  level... one more instrument without sounding crowded"

- 2026-07-15 · A · ARRANGEMENT ENGINE: song-arc state machine (intro→verse→
  rise→turn→peak→hush→finale→tag, ~one change per passage, composed 2-bar tag,
  endless song-shaped cycling; passage label shown in transport) · "none of
  ours are actual songs"
- 2026-07-15 · T · FIDDLE: new Bowed instrument class, VSCO solo violin
  sustains (9 notes, pitch-verified), formant-synth fallback; bowedLine
  generator (root long tones, fifth every 4th bar, double-stop in hush);
  added to shanty/reel/slip/grove/willow; new chip + Fiddle level slider ·
  "droning croony melody instrument"
- 2026-07-15 · G/T · SHANTY PIRATE REWORK: 4/4→swung 6/8 with lilt, halyard
  one-pull-per-bar + gang clap answer, ACCORDION bellows bed (FreePats CC0,
  octave-verified), fiddle croon, hemiola fills, rough=1.6 timing scatter,
  i-bVII double-tonic + iv/bVI/v B-section · "doesn't sound like a pirate song"
- 2026-07-15 · G · CÉILÍ DANCE (was Kerry Polka): all chords open fifths
  (no thirds/DADGAD ambiguity), ONE bodhrán pattern (down-up down down),
  132 BPM · "not diddly enough / more Gaelic"

## Reference deck (growing)

- Justin Bell — "The Fox and the Farmer" (Pillars of Eternity): anchors V
  (understated accompaniment, flute floats on top).
- David Arkenstone — "Blood Sail" (title to verify): anchors A (layers,
  adventure arc, actual song shape).

One line per change, newest first. Format: date · dimension (T/G/A/M/V/P) · change · trigger.

- 2026-07-15 · M · sampled lute .45→.72, harp .42→.68, oud bus .60→.54 · "lute/harp too quiet vs oud" (attack-presence, not RMS)
- 2026-07-15 · G/V · Kerry Polka added (2/4, A mix, I-bVII vamp) · "super gaelic but upbeat"
- 2026-07-15 · P · Setup split into Tune Key / Your Instrument, hint under grid · "two key selectors, obtuse"
- 2026-07-15 · T · sampled strings (FreePats guitar→lute, harp); VSCO bass FAILED pitch verification, stayed synth · Build 3
- 2026-07-15 · G · jig lilt .06-.07 on jig/festival/slip · research (soft-dotted eighths)
- 2026-07-15 · P · Play/Setup tab split; Keep-this-sound cards · "UI fried", customizability
- 2026-07-14 · T · bodhran tek sampled (muted small frame hits) · "shh at density = shaker"
- 2026-07-14 · T · HDrumL_Hand rub stroke evicted from dum pool · "one of the four plays twice"
- 2026-07-14 · T · bongo fingers sampled (darbuka strokes 4/5) · "sh with only drums on"
- 2026-07-14 · V · shaker removed everywhere · "double-shake = snare, remove it"
- 2026-07-14 · T · VCSL percussion sampled; ribbon-shelf EQ; small-room IR · "sounds aren't acoustic"
- 2026-07-14 · V · claps rowdy-only 1/bar; tss 1/bar (6/8: every other bar) · "clap far too frequent, tss too"
- 2026-07-14 · V · section-committed patterns; deterministic tss · accompanist doctrine
- 2026-07-14 · G · per-drum re-strike gates; texture avoids occupied steps · "closer than a human could play"
- 2026-07-14 · G · rowdy de-densified (jig/reel) · "breakcore"
- 2026-07-14 · T · membrane drums replace pitch-sweep · "sounds like kicks"
- 2026-07-14 · T · bass rounded (bright .22, pick .45, 760Hz LP, 12ms ramp); reverb −30%, IR 1.7s · "bass aggressive, reverb high"
- 2026-07-14 · M · bass .78→.55; drums .82→.98; busier lively patterns · "bass too powerful, drums underworking"
- 2026-07-14 · M · tanh soft-clip master replaces compressor chain · clipping + auto-makeup-gain
