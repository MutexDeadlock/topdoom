/**
 * The FM synthesis chip DOOM's music was written for: an OPL emulation driven by register writes,
 * rendering into a float buffer. Knows nothing about MIDI — `synth.ts` does the register writing.
 * See docs/music.md § The chip.
 */

/**
 * The chip's own sample rate: its 3.579545 MHz master clock divided by 72
 * (14.318 MHz / 288 on the OPL3, the same number). It is what a register's
 * F-number *means* — `blockAndFnum` converts against it — and stays that
 * whatever rate the output is rendered at. See docs/music.md § The chip.
 */
export const OPL_RATE = 49716;

/** Two-operator channels per register bank — nine, on every chip in the family. */
const CHANNELS_PER_BANK = 9;

/**
 * Two-operator channels. **Deliberately not the hardware's 18** (the OPL3's two banks of nine):
 * four banks are instantiated instead, because 18 is where a busy score starts losing notes — the
 * same reasoning as `CHANNELS` = 32 in `audio/audio.ts`, and it costs nothing, since an idle
 * channel is skipped in {@link OplChip.render}. Nothing above this cares: {@link channelRegisters}
 * addresses the extra banks the way the OPL3 addresses its second. See docs/music.md § The chip.
 */
export const OPL_CHANNELS = 36;

/**
 * Register offsets of a bank's channel 0-8 **modulator**; the carrier sits
 * three higher. The gap is the chip's own: its 22 operator slots are addressed
 * in three rows of six with two unused addresses after each.
 */
const MODULATOR_OFFSETS = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];

/**
 * Where one channel's registers live: the per-channel ones (0xA0, 0xB0, 0xC0)
 * at `channel`, and its two operators' (0x20, 0x40, 0x60, 0x80, 0xE0) at
 * `modulator`/`carrier` — each already carrying the bank in the high byte, as
 * the OPL3 puts its second bank at 0x100. `synth.ts` writes registers with
 * these; nothing else needs to know how the chip lays its operators out.
 */
export function channelRegisters(index: number): { channel: number; modulator: number; carrier: number } {
  const bank = Math.floor(index / CHANNELS_PER_BANK) << 8;
  const within = index % CHANNELS_PER_BANK;
  const modulator = bank | MODULATOR_OFFSETS[within];
  return { channel: bank | within, modulator, carrier: modulator + 3 };
}

/** `MULTI`'s 16 settings, which are the harmonic number except that 0 means a half. */
const MULTIPLIERS = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

/**
 * The envelope generator's resolution, 1/16 of 1.5 dB, and its full range: 96 dB
 * of attenuation in 1024 steps. Every attenuation in this file — envelope,
 * total level, key scale, tremolo — is in these units, so they add.
 */
const ATTEN_UNIT_DB = 0.09375;
const MAX_ATTEN = 1023;
/** `TL`'s own step is 0.75 dB, eight of the units above. */
const TL_UNITS = 8;
/** `SL`'s step is 3 dB — except 15, which the chip reads as full attenuation, not 45 dB. */
const SL_UNITS = 32;

/**
 * Envelope times at rate index 4, halving for every further 4 of the 6-bit rate
 * index (`4 * R + ksr`) — the YM3812 manual's own figures: an attack from 2.8 s
 * down to 0.17 ms, and a decay/release sweep of the full 96 dB from 39 s down
 * to 2.4 ms. A rate field of 0 never advances at all, which is the chip's
 * "infinite" and not a very slow rate. See docs/music.md § Envelopes.
 */
const ATTACK_BASE = 2.8254;
const DECAY_BASE = 39.2806;

/**
 * Full-scale modulator output shifts the carrier by four whole cycles: the
 * chip adds the operator's 13-bit signed output (±4084) into the 10-bit phase
 * counter as it stands — the reverse-engineered data path (Nuked OPL3), not a
 * datasheet figure. Feedback averages the last two outputs shifted by
 * `9 - FB`, so `FB` of 7 feeds back at half the modulation depth — two cycles
 * — and 0 not at all.
 */
const MOD_DEPTH = 4;

/** The two global LFOs (`s_sound`'s AM/VIB): 3.7 Hz of tremolo, 6.1 Hz of vibrato. */
const TREMOLO_HZ = 3.7;
const VIBRATO_HZ = 6.1;
/** Tremolo depth in dB, shallow and deep (register 0xBD bit 7). */
const TREMOLO_DB = [1.0, 4.8];
/** Vibrato depth in cents, shallow and deep (register 0xBD bit 6). */
const VIBRATO_CENTS = [7, 14];

/**
 * Output scale for the summed channels. **Tuned by feel**: the chip's DAC sums
 * its channels into a fixed-width output and hard-clips, and how loud that ends
 * up is a property of the sound card's analogue stage rather than anything the
 * registers say. Set so a typical track sits at a useful level, which leaves a
 * dense one's transients **past full scale** — deliberately: nothing is limited
 * here, since the volume control comes after this and a peak clipped now is
 * clipped even at a quarter volume. The music bus carries the safety curve
 * instead (docs/music.md § Volume).
 */
const MASTER_SCALE = 0.2;

/**
 * DC-blocking coefficient, for a one-pole high-pass at about 15 Hz. Half the
 * chip's waveforms (`|sin|`, the half and quarter sines) are unipolar and carry
 * a DC offset that eats headroom asymmetrically; every OPL card's analogue
 * stage was AC-coupled and removed it, so this is the hardware's own behavior
 * rather than a liberty.
 */
const DC_BLOCK_HZ = 15;

/** Waveform samples, one table per `WS` setting; indexed by the 10-bit phase the chip uses. */
const WAVE_STEPS = 1024;
const WAVES = buildWaves();

/** Gain for an attenuation in {@link ATTEN_UNIT_DB} units, silent past the envelope's 96 dB. */
const GAIN = buildGainTable();

/**
 * Key-scale-level attenuation at block 7 for each sixteenth of the F-number
 * range, in dB — the chip's own table, from which every lower block subtracts
 * 6 dB (clamped at zero). The `KSL` field then divides it: its four settings
 * are 0, 3, 1.5 and 6 dB per octave **in that order**, which is why 1 and 2
 * look swapped against the field's numeric value.
 */
const KSL_BLOCK7 = [
  0.0, 9.0, 12.0, 13.875, 15.0, 16.125, 16.875, 17.625, 18.0, 18.75, 19.125, 19.5, 19.875, 20.25, 20.625, 21.0,
];
const KSL_DIVISOR = [Infinity, 2, 4, 1];

type EnvelopeState = 'off' | 'attack' | 'decay' | 'sustain' | 'release';

/**
 * One of a channel's two operators: a phase generator, an envelope, and the levels feeding both.
 */
class Operator {
  // Register 0x20.
  tremolo = false;
  vibrato = false;
  /** `EGT`: hold at the sustain level instead of decaying on through it. */
  sustaining = false;
  keyScaleRate = false;
  multiplier = MULTIPLIERS[0];
  // Registers 0x40, 0x60, 0x80, 0xE0.
  keyScaleLevel = 0;
  totalLevel = 0;
  attackRate = 0;
  decayRate = 0;
  sustainLevel = 0;
  releaseRate = 0;
  wave = WAVES[0];

  /** Phase in cycles, kept in [0, 1) so it stays exact however long a note holds. */
  phase = 0;
  phaseStep = 0;

  state: EnvelopeState = 'off';
  /** Attenuation in {@link ATTEN_UNIT_DB} units: 0 is full volume, {@link MAX_ATTEN} silence. */
  envelope = MAX_ATTEN;
  /** Per-sample factor for the attack's exponential approach, and the linear steps for the rest. */
  attackFactor = 0;
  decayStep = 0;
  releaseStep = 0;
  /**
   * {@link Operator.sustainLevel} in attenuation units, and {@link Operator.totalLevel} plus key
   * scaling in the same.
   */
  sustainAtten = 0;
  fixedAtten = 0;

  /**
   * This operator's last output, and the one before it — the pair the chip averages for feedback.
   */
  out = 0;
  prevOut = 0;
}

class Channel {
  ops: [Operator, Operator] = [new Operator(), new Operator()];
  fnum = 0;
  block = 0;
  keyOn = false;
  /** True for additive (`CNT` 1), where both operators reach the output. */
  additive = false;
  /** `FB` folded into the phase shift it produces, zero when feedback is off. */
  feedback = 0;
  /** The OPL3's stereo gates (register 0xC0 bits 4 and 5) — a channel is on a side or it isn't. */
  leftGate = true;
  rightGate = true;
  /** Where the channel sits between the two, as a constant-power pair — see {@link OplChip.setPan}. */
  panLeft = Math.SQRT1_2;
  panRight = Math.SQRT1_2;
  /** The two multiplied together, so {@link OplChip.render} needs neither branch nor lookup. */
  gainLeft = Math.SQRT1_2;
  gainRight = Math.SQRT1_2;
}

/**
 * An OPL emulation: registers in, samples out. Faithful in the parts that shape
 * the sound — the phase/envelope/level model, the waveforms, key scaling, the
 * two LFOs — and deliberately not a gate-level reproduction of the chip's
 * timing. Its percussion mode is left out because DMX never used it: DOOM's
 * drums are melodic voices with a fixed note (docs/music.md § What the synth
 * ignores).
 */
export class OplChip {
  private channels: Channel[] = [];
  /** Register offset (within a bank) → the operator it addresses, and that operator's channel. */
  private operatorAt = new Map<number, { op: Operator; channel: Channel }>();

  /**
   * Samples per second of *output*, which is the `AudioContext`'s rate and not the chip's own
   * {@link OPL_RATE} — rendering straight at the destination rate keeps the browser from resampling
   * every scheduled buffer separately. Register semantics are unaffected: an F-number still means
   * the frequency {@link OPL_RATE} says it does. docs/music.md § The chip.
   */
  private rate: number;
  /** `OPL_RATE / rate`, the one factor that carries the chip's timebase into this one. */
  private timebase: number;

  /**
   * The channels {@link OplChip.render} actually has to sum, rebuilt at the top of each call; a
   * field so a render allocates nothing. See docs/music.md § The chip.
   */
  private live: Channel[] = [];

  private tremoloPhase = 0;
  private vibratoPhase = 0;
  private tremoloDepth = TREMOLO_DB[0];
  private vibratoDepth = VIBRATO_CENTS[0];
  /** One-pole DC blocker state, per side — see {@link DC_BLOCK_HZ}. */
  private dcInLeft = 0;
  private dcOutLeft = 0;
  private dcInRight = 0;
  private dcOutRight = 0;
  private dcCoefficient: number;

  constructor(sampleRate: number = OPL_RATE) {
    this.rate = sampleRate > 0 ? sampleRate : OPL_RATE;
    this.timebase = OPL_RATE / this.rate;
    this.dcCoefficient = 1 - (2 * Math.PI * DC_BLOCK_HZ) / this.rate;
    for (let i = 0; i < OPL_CHANNELS; i++) {
      const channel = new Channel();
      this.channels.push(channel);
      const regs = channelRegisters(i);
      this.operatorAt.set(regs.modulator, { op: channel.ops[0], channel });
      this.operatorAt.set(regs.carrier, { op: channel.ops[1], channel });
    }
  }

  /** Silences everything and forgets every setting — what a fresh chip looks like. */
  reset(): void {
    this.dcInLeft = 0;
    this.dcOutLeft = 0;
    this.dcInRight = 0;
    this.dcOutRight = 0;
    for (const channel of this.channels) {
      channel.keyOn = false;
      channel.leftGate = true;
      channel.rightGate = true;
      channel.panLeft = Math.SQRT1_2;
      channel.panRight = Math.SQRT1_2;
      this.updateGains(channel);
      for (const op of channel.ops) {
        op.state = 'off';
        op.envelope = MAX_ATTEN;
        op.out = 0;
        op.prevOut = 0;
        op.phase = 0;
      }
    }
  }

  /**
   * One register write, addressed as the chip is: the high byte selects a bank
   * of nine channels (0x000 the first, 0x100 the second, as on the OPL3, and on
   * up through this chip's extra ones — see {@link OPL_CHANNELS}), the low byte the
   * register within it. The OPL3 enable bit (0x105) and percussion mode (0xBD
   * bits 0-5) are accepted and ignored: this always runs as a melodic chip.
   */
  write(reg: number, value: number): void {
    const bank = reg & 0xff00;
    const low = reg & 0xff;
    const group = low & 0xf0;

    if (low === 0xbd) {
      this.tremoloDepth = TREMOLO_DB[(value >> 7) & 1];
      this.vibratoDepth = VIBRATO_CENTS[(value >> 6) & 1];
      return;
    }
    if (group === 0xa0 || group === 0xb0) {
      const index = low & 0x0f;
      if (index >= CHANNELS_PER_BANK) return;
      const channel = this.channels[(bank >> 8) * CHANNELS_PER_BANK + index];
      if (!channel) return; // a bank past the ones instantiated
      if (group === 0xa0) channel.fnum = (channel.fnum & 0x300) | value;
      else {
        channel.fnum = (channel.fnum & 0xff) | ((value & 0x03) << 8);
        channel.block = (value >> 2) & 0x07;
        const on = (value & 0x20) !== 0;
        if (on !== channel.keyOn) {
          channel.keyOn = on;
          for (const op of channel.ops) this.key(op, on);
        }
      }
      for (const op of channel.ops) this.updatePhaseStep(op, channel);
      // Key scaling — of both level and envelope rate — follows block and
      // F-number, so both have to be recomputed here and not only on 0x40/0x60.
      for (const op of channel.ops) {
        this.updateLevels(op, channel);
        this.updateRates(op, channel);
      }
      return;
    }
    if (group === 0xc0) {
      const index = low & 0x0f;
      if (index >= CHANNELS_PER_BANK) return;
      const channel = this.channels[(bank >> 8) * CHANNELS_PER_BANK + index];
      if (!channel) return;
      channel.additive = (value & 0x01) !== 0;
      const fb = (value >> 1) & 0x07;
      channel.feedback = fb === 0 ? 0 : Math.pow(2, fb - 7) * (MOD_DEPTH / 2);
      // The OPL3's stereo gates. Neither bit set is an OPL2-era write that
      // predates them, which a chip in OPL2 mode plays through both sides —
      // silence would be the letter of the OPL3 spec and no use to anyone.
      const left = (value & 0x10) !== 0;
      const right = (value & 0x20) !== 0;
      channel.leftGate = left || !right;
      channel.rightGate = right || !left;
      this.updateGains(channel);
      return;
    }

    const slot = this.operatorAt.get(bank | (low & 0x1f));
    if (!slot || group < 0x20) return;
    const { op, channel } = slot;
    // Each operator group spans 0x20 of address space, not 0x10: slots 0x10-0x15
    // (channels 6-8) cross the nibble, putting their writes at 0x30-0x35,
    // 0x50-0x55, 0x70-0x75, 0x90-0x95 and 0xF0-0xF5 — so the dispatch masks with
    // `low & 0xe0`; `low & 0xf0` would leave a third of the chip unpatched.
    switch (low & 0xe0) {
      case 0x20:
        op.tremolo = (value & 0x80) !== 0;
        op.vibrato = (value & 0x40) !== 0;
        op.sustaining = (value & 0x20) !== 0;
        op.keyScaleRate = (value & 0x10) !== 0;
        op.multiplier = MULTIPLIERS[value & 0x0f];
        this.updatePhaseStep(op, channel);
        this.updateRates(op, channel);
        break;
      case 0x40:
        op.keyScaleLevel = (value >> 6) & 0x03;
        op.totalLevel = value & 0x3f;
        this.updateLevels(op, channel);
        break;
      case 0x60:
        op.attackRate = (value >> 4) & 0x0f;
        op.decayRate = value & 0x0f;
        this.updateRates(op, channel);
        break;
      case 0x80:
        op.sustainLevel = (value >> 4) & 0x0f;
        op.releaseRate = value & 0x0f;
        op.sustainAtten = op.sustainLevel === 0x0f ? MAX_ATTEN : op.sustainLevel * SL_UNITS;
        this.updateRates(op, channel);
        break;
      case 0xe0:
        op.wave = WAVES[value & 0x07];
        break;
      default:
        break;
    }
  }

  /**
   * Where a channel sits in the stereo image: 0 hard left, 1 hard right, as a
   * constant-power pair of gains.
   *
   * **Deliberately finer than the chip's own pan**, which is the two gate bits above and nothing
   * else — DMX therefore quantizes a score's pan to hard left, hard right or centre, audible as
   * damage rather than width (E1M1's two guitars). The gates still apply on top of this, so a bank
   * that writes them keeps its meaning. docs/music.md § From notes to registers.
   */
  setPan(index: number, pan: number): void {
    const channel = this.channels[index];
    if (!channel) return;
    const angle = Math.max(0, Math.min(1, pan)) * (Math.PI / 2);
    channel.panLeft = Math.cos(angle);
    channel.panRight = Math.sin(angle);
    this.updateGains(channel);
  }

  /**
   * How far below full scale whatever is left on a channel currently sits, in the envelope's own
   * attenuation units — `Infinity` once nothing reaches the output at all. A read-only peek for
   * `OplSynth.allocate`; real DMX had no such view into the chip, an emulated one does.
   * docs/music.md § From notes to registers.
   */
  channelAttenuation(index: number): number {
    const channel = this.channels[index];
    if (!channel) return Infinity;
    const [mod, car] = channel.ops;
    const carAtten = car.state === 'off' ? Infinity : car.envelope + car.fixedAtten;
    if (!channel.additive) return carAtten;
    const modAtten = mod.state === 'off' ? Infinity : mod.envelope + mod.fixedAtten;
    return Math.min(modAtten, carAtten);
  }

  /**
   * Renders `count` samples into the two output buffers, replacing what is
   * there. Stereo because the OPL3 is: each channel is gated to one side or
   * both by its own register, and DMX drives those gates from the score's pan
   * (docs/music.md § From notes to registers).
   */
  render(left: Float32Array, right: Float32Array, count: number): void {
    const tremoloStep = TREMOLO_HZ / this.rate;
    const vibratoStep = VIBRATO_HZ / this.rate;
    // A channel with both operators off contributes nothing, and its phases
    // don't matter either — key-on resets them. Collected once here rather than
    // tested per sample, which is what keeps a chip with three notes held
    // costing three notes and not thirty-six.
    //
    // The test is *either* operator, not just the ones that reach the output: a
    // modulator still running under a finished carrier adds nothing to the mix,
    // but its envelope has to keep advancing, or where it has got to by the next
    // key-on would depend on where the render calls happened to fall.
    const live = this.live;
    live.length = 0;
    // Whether anything live even uses an LFO is collected alongside: like the
    // depths, the flags only change through writes between calls, and knowing
    // lets the loop below skip the per-sample vibrato `Math.pow` — the one
    // transcendental in it — whenever nothing sounding asks for it.
    let anyTremolo = false;
    let anyVibrato = false;
    for (let c = 0; c < OPL_CHANNELS; c++) {
      const channel = this.channels[c];
      const mod = channel.ops[0];
      const car = channel.ops[1];
      if (mod.state === 'off' && car.state === 'off') continue;
      live.push(channel);
      anyTremolo = anyTremolo || mod.tremolo || car.tremolo;
      anyVibrato = anyVibrato || mod.vibrato || car.vibrato;
    }
    const tremoloUnits = this.tremoloDepth / ATTEN_UNIT_DB;

    for (let i = 0; i < count; i++) {
      this.tremoloPhase = (this.tremoloPhase + tremoloStep) % 1;
      this.vibratoPhase = (this.vibratoPhase + vibratoStep) % 1;
      // Both LFOs are triangles on the chip: tremolo rises and falls through
      // its depth of attenuation, vibrato swings either side of the note. A
      // sawtooth tremolo would snap back once a cycle, which is a click at
      // 3.7 Hz on every patch that sets AM.
      const tremolo = anyTremolo ? triangle(this.tremoloPhase) * tremoloUnits : 0;
      const vibrato = anyVibrato
        ? Math.pow(2, (this.vibratoDepth * (2 * triangle(this.vibratoPhase) - 1)) / 1200)
        : 1;

      let sumLeft = 0;
      let sumRight = 0;
      for (let c = 0; c < live.length; c++) {
        const channel = live[c];
        const mod = channel.ops[0];
        const car = channel.ops[1];
        const feedback = channel.feedback === 0 ? 0 : ((mod.out + mod.prevOut) / 2) * channel.feedback;
        const modOut = this.step(mod, feedback, tremolo, vibrato);
        const carOut = this.step(car, channel.additive ? 0 : modOut * MOD_DEPTH, tremolo, vibrato);
        const value = channel.additive ? modOut + carOut : carOut;
        sumLeft += value * channel.gainLeft;
        sumRight += value * channel.gainRight;
      }
      // The card's AC-coupled output stage. Nothing clips here — see `MASTER_SCALE`.
      const scaledLeft = sumLeft * MASTER_SCALE;
      this.dcOutLeft = scaledLeft - this.dcInLeft + this.dcCoefficient * this.dcOutLeft;
      this.dcInLeft = scaledLeft;
      left[i] = this.dcOutLeft;
      const scaledRight = sumRight * MASTER_SCALE;
      this.dcOutRight = scaledRight - this.dcInRight + this.dcCoefficient * this.dcOutRight;
      this.dcInRight = scaledRight;
      right[i] = this.dcOutRight;
    }
  }

  private updateGains(channel: Channel): void {
    channel.gainLeft = channel.leftGate ? channel.panLeft : 0;
    channel.gainRight = channel.rightGate ? channel.panRight : 0;
  }

  /**
   * Key-on restarts the phase and re-enters attack from wherever the envelope currently sits — the
   * chip does not reset it to silence first, which is what makes a retriggered note continue rather
   * than click.
   *
   * The feedback history is cleared with the phase, and that is load-bearing: an operator only
   * writes {@link Operator.out}/{@link Operator.prevOut} on the samples its channel is *live* for,
   * so rendering would otherwise depend on how the output is cut into chunks.
   * docs/music.md § The chip.
   */
  private key(op: Operator, on: boolean): void {
    if (on) {
      op.phase = 0;
      op.out = 0;
      op.prevOut = 0;
      // An attack rate of 15 is instant on the chip, where the exponential
      // approach below would only ever get close — so it lands in decay outright.
      if (op.attackRate === 15) {
        op.envelope = 0;
        op.state = 'decay';
      } else {
        op.state = 'attack';
      }
    } else if (op.state !== 'off') {
      op.state = 'release';
    }
  }

  private updatePhaseStep(op: Operator, channel: Channel): void {
    // The chip's frequency — F-number scaled by the block, over a 2^20 divider
    // — as a fraction of a cycle per *output* sample.
    op.phaseStep = ((channel.fnum * Math.pow(2, channel.block)) / (1 << 20)) * op.multiplier * this.timebase;
  }

  private updateLevels(op: Operator, channel: Channel): void {
    const divisor = KSL_DIVISOR[op.keyScaleLevel];
    const scaled = Math.max(0, KSL_BLOCK7[(channel.fnum >> 6) & 0x0f] - 6 * (7 - channel.block)) / divisor;
    op.fixedAtten = op.totalLevel * TL_UNITS + scaled / ATTEN_UNIT_DB;
  }

  /**
   * Envelope rates, which key-scale off the note: the 6-bit rate index is `4 * R + ksr`.
   * See docs/music.md § Envelopes.
   */
  private updateRates(op: Operator, channel: Channel): void {
    const fnumTop = (channel.fnum >> 9) & 1;
    const ksr = op.keyScaleRate ? (channel.block << 1) | fnumTop : channel.block >> 1;
    op.attackFactor = attackFactor(op.attackRate, ksr, this.rate);
    op.decayStep = sweepStep(op.decayRate, ksr, this.rate);
    op.releaseStep = sweepStep(op.releaseRate, ksr, this.rate);
  }

  /**
   * Advances one operator by a sample and returns its output: phase plus
   * whatever is modulating it through the waveform, scaled by the envelope,
   * total level, key scaling and tremolo added up in the attenuation domain.
   */
  private step(op: Operator, phaseMod: number, tremolo: number, vibrato: number): number {
    if (op.state === 'off') {
      op.prevOut = op.out;
      op.out = 0;
      return 0;
    }
    this.advanceEnvelope(op);

    op.phase += op.vibrato ? op.phaseStep * vibrato : op.phaseStep;
    if (op.phase >= 1) op.phase -= Math.floor(op.phase);
    const index = (((op.phase + phaseMod) * WAVE_STEPS) | 0) & (WAVE_STEPS - 1);

    let atten = op.envelope + op.fixedAtten;
    if (op.tremolo) atten += tremolo;
    const gain = GAIN[atten > MAX_ATTEN ? MAX_ATTEN + 1 : atten | 0];
    const value = op.wave[index] * gain;
    op.prevOut = op.out;
    op.out = value;
    return value;
  }

  private advanceEnvelope(op: Operator): void {
    switch (op.state) {
      case 'attack':
        if (op.attackFactor === 0) break; // rate 0: never advances
        op.envelope *= op.attackFactor;
        if (op.envelope < 1) {
          op.envelope = 0;
          op.state = 'decay';
        }
        break;
      case 'decay':
        op.envelope += op.decayStep;
        if (op.envelope >= op.sustainAtten) {
          op.envelope = op.sustainAtten;
          // A sustaining envelope holds here; a percussive one carries straight
          // on down at its *release* rate without waiting for a key-off.
          op.state = op.sustaining ? 'sustain' : 'release';
        }
        break;
      case 'sustain':
        break;
      case 'release':
        op.envelope += op.releaseStep;
        if (op.envelope >= MAX_ATTEN) {
          op.envelope = MAX_ATTEN;
          op.state = 'off';
        }
        break;
      default:
        break;
    }
  }
}

function buildWaves(): Float32Array[] {
  const waves: Float32Array[] = [];
  for (let w = 0; w < 8; w++) waves.push(new Float32Array(WAVE_STEPS));
  for (let i = 0; i < WAVE_STEPS; i++) {
    const t = i / WAVE_STEPS;
    const sine = Math.sin(2 * Math.PI * t);
    waves[0][i] = sine;
    // 1: the negative half silenced. 2: rectified. 3: rectified with the second
    // and fourth quarters silenced. 4-7 exist on the OPL3 only, and `GENMIDI`
    // (an OPL2 bank, `#OPL_II#`) never selects them — they are here so a
    // DMXOPL-style replacement bank that does isn't rendered as silence.
    waves[1][i] = sine > 0 ? sine : 0;
    waves[2][i] = Math.abs(sine);
    waves[3][i] = t % 0.5 < 0.25 ? Math.abs(sine) : 0;
    waves[4][i] = t < 0.5 ? Math.sin(4 * Math.PI * t) : 0;
    waves[5][i] = t < 0.5 ? Math.abs(Math.sin(4 * Math.PI * t)) : 0;
    waves[6][i] = t < 0.5 ? 1 : -1;
    // 7 is an exponentially falling ramp, mirrored in the second half.
    waves[7][i] = t < 0.5 ? Math.pow(2, -16 * t) : -Math.pow(2, -16 * (t - 0.5));
  }
  return waves;
}

function buildGainTable(): Float32Array {
  const table = new Float32Array(MAX_ATTEN + 2);
  for (let i = 0; i <= MAX_ATTEN; i++) table[i] = Math.pow(10, (-i * ATTEN_UNIT_DB) / 20);
  table[MAX_ATTEN + 1] = 0;
  return table;
}

/** A 0-1 triangle over one cycle of an LFO phase, which is the shape both of the chip's are. */
function triangle(phase: number): number {
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

/**
 * Per-sample multiplier that takes the envelope from silence to full over the attack's own time.
 */
function attackFactor(rate: number, ksr: number, sampleRate: number): number {
  if (rate === 0) return 0;
  const samples = ATTACK_BASE * Math.pow(2, (4 - Math.min(63, rate * 4 + ksr)) / 4) * sampleRate;
  // From MAX_ATTEN down to under 1, i.e. by a factor of 1024, in `samples` steps.
  return Math.pow(1 / (MAX_ATTEN + 1), 1 / Math.max(1, samples));
}

/**
 * Per-sample attenuation step of a decay or release, both of which sweep the full range linearly.
 */
function sweepStep(rate: number, ksr: number, sampleRate: number): number {
  if (rate === 0) return 0;
  const samples = DECAY_BASE * Math.pow(2, (4 - Math.min(63, rate * 4 + ksr)) / 4) * sampleRate;
  return (MAX_ATTEN + 1) / Math.max(1, samples);
}
