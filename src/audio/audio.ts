import { Vector3, type Quaternion } from 'three/webgpu';
import { shoreZ } from '../land/terrain';
import { WATERFALL_IMPACT } from '../land/waterfall';
import type { SurfSample, SurfSimulation } from '../water/surf';
import { createAmbience, type Ambience } from './ambience';

/** How much of each part of the day is in the air, from 0 to 1. */
interface Soundscape { daylight: number; chorus: number; night: number }

/** Procedural, seamless ocean ambience and wildlife that follow the time of day, with gesture recovery for browser autoplay. */
export class IslandAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private ambience?: Ambience;
  private immersion = 0;
  private waterDepth = 0;
  private readonly listenerRight = new Vector3();
  private readonly fallsOffset = new Vector3();
  private readonly surfSample: SurfSample = { elevation: 0, velocity: 0, depth: 0, foam: 0, air: 0 };
  private soundscape: Soundscape = { daylight: 1, chorus: 0, night: 0 };
  private insectGain = 0;
  private volume = 0.55;
  private enabled = false;
  private request = 0;
  private birdTimer?: ReturnType<typeof setTimeout>;
  private songTimer?: ReturnType<typeof setTimeout>;
  private insectTimer?: ReturnType<typeof setTimeout>;
  private suspendTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    document.addEventListener('visibilitychange', this.visibilityChange);
    document.addEventListener('pointerdown', this.resumeOnInteraction, true);
    document.addEventListener('keydown', this.resumeOnInteraction, true);
  }

  private resumeOnInteraction = (): void => {
    if (this.enabled && this.context?.state === 'suspended') {
      void this.setEnabled(true).catch(() => {});
    }
  };

  async setEnabled(enabled: boolean): Promise<void> {
    const request = ++this.request;
    this.enabled = enabled;
    clearTimeout(this.suspendTimer);
    this.clearSchedules();
    if (enabled) {
      if (!this.context) this.createGraph();
      await this.resume(request, true);
    } else if (this.context && this.master) {
      this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.22);
      this.suspendTimer = setTimeout(() => {
        if (!this.enabled && this.context?.state === 'running') void this.context.suspend();
      }, 1000);
    }
  }

  private async resume(request: number, initial = false): Promise<void> {
    const context = this.context;
    if (!context || !this.master) return;
    // Listener depth keeps updating while muted. Clear old automation before
    // resuming so a dive cannot briefly replay the previous surface mix.
    if (context.state === 'suspended') this.applyImmersion(true);
    await context.resume();
    if (!this.enabled || document.hidden || request !== this.request) return;
    this.applyImmersion();
    this.master.gain.setTargetAtTime(this.volume, context.currentTime, .65);
    this.clearSchedules();
    this.scheduleBird(initial ? 10 : undefined);
    this.scheduleSong(initial ? 2 : undefined);
    this.scheduleInsects();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0.55));
    if (this.enabled && this.context && this.master) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.2);
  }

  /** The listener crosses the actual moving waterline, independently of mute. */
  updateImmersion(depth: number): void {
    const waterDepth = Math.max(0, Number.isFinite(depth) ? depth : 0);
    const t = Math.min(1, Math.max(0, (waterDepth - .015) / .30));
    const immersion = t * t * (3 - 2 * t);
    if (Math.abs(immersion - this.immersion) < .001 && Math.abs(waterDepth - this.waterDepth) < .025) return;
    this.immersion = immersion;
    this.waterDepth = waterDepth;
    if (this.context?.state === 'running') this.applyImmersion();
  }

  private applyImmersion(immediate = false): void {
    this.ambience?.setImmersion(this.immersion, this.waterDepth, immediate);
  }

  /** Crickets fade in with the dark; gulls and songbirds keep to the daylight. */
  setSoundscape(soundscape: Soundscape): void {
    this.soundscape = { ...soundscape };
    const level = this.insectLevel();
    if (this.context && this.ambience && Math.abs(level - this.insectGain) > 0.01) {
      this.insectGain = level;
      this.ambience.insects.gain.setTargetAtTime(level, this.context.currentTime, 0.8);
    }
  }

  private createGraph(): void {
    const context = new AudioContext();
    this.context = context;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -15;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.08;
    compressor.release.value = 0.4;
    this.master = context.createGain();
    this.master.gain.value = 0;
    this.master.connect(compressor).connect(context.destination);

    this.ambience = createAmbience(context, this.master);
    this.insectGain = this.insectLevel();
    this.ambience.insects.gain.value = this.insectGain;
    this.applyImmersion(true);
  }

  private insectLevel(): number { return Math.min(1, Math.max(0, (this.soundscape.night - 0.25) / 0.6)); }

  /** Called after the water step, using its exact bores, bubbles and foam.
   * Surf noise is the ringing of freshly entrained bubbles, so the roar follows
   * the air each bore carries; the hiss follows foam riding the swash.
   * No wave timer, random envelopes, or independent audio clock can drift away
   * from what is on screen. Short gain smoothing only removes frame stepping.
   */
  updateSurf(waves: SurfSimulation, position: Vector3, rotation: Quaternion): void {
    if (!this.enabled || this.context?.state !== 'running' || document.hidden) return;
    const now = this.context.currentTime;
    this.listenerRight.set(1, 0, 0).applyQuaternion(rotation);
    for (const voice of this.ambience!.surfVoices) {
      const x = Math.max(-105, Math.min(105, position.x + voice.offset));
      let breaking = 0, wash = 0, retreat = 0;
      for (const d of [-6, -4.5, -3, -1.8, -.8, .2, 1.2]) {
        const sample = waves.sample(x, d, this.surfSample);
        const incoming = Math.max(0, sample.velocity), outgoing = Math.max(0, -sample.velocity);
        breaking = Math.max(breaking, Math.min(1.5, sample.air * 40) * (d < -2 ? 1 : .4));
        wash = Math.max(wash, sample.foam * incoming * .65);
        retreat = Math.max(retreat, sample.foam * outgoing * .8);
      }
      const dx = x - position.x, dz = shoreZ(x) - 3.5 - position.z;
      const distance = Math.hypot(dx, dz, position.y);
      const attenuation = 1 / (1 + distance / 14);
      const pan = (dx * this.listenerRight.x + dz * this.listenerRight.z) / Math.max(distance, 1);
      voice.pan.pan.setTargetAtTime(Math.max(-.9, Math.min(.9, pan)), now, .08);
      voice.body.gain.setTargetAtTime((.012 + Math.min(1.5, breaking) * .22) * attenuation, now, .055);
      voice.wash.gain.setTargetAtTime(Math.min(1.5, wash) * .27 * attenuation, now, .09);
      voice.retreat.gain.setTargetAtTime(Math.min(1.2, retreat) * .19 * attenuation, now, .14);
      voice.filter.frequency.setTargetAtTime((1800 + Math.min(1, breaking) * 4000) / (1 + distance / 100), now, .09);
    }
  }

  /** The waterfall roars from its impact: louder near it, duller far away as air absorbs the highs. */
  updateFalls(position: Vector3, rotation: Quaternion): void {
    if (!this.enabled || this.context?.state !== 'running' || document.hidden) return;
    const now = this.context.currentTime, voice = this.ambience!.falls;
    const offset = this.fallsOffset.copy(WATERFALL_IMPACT.position).sub(position);
    offset.y += 2;
    const distance = offset.length();
    this.listenerRight.set(1, 0, 0).applyQuaternion(rotation);
    // Sound power grows with the falling water's power; pressure falls off with distance.
    const level = Math.sqrt(WATERFALL_IMPACT.power / 5e4) / (1 + distance / 5);
    voice.pan.pan.setTargetAtTime(Math.max(-.85, Math.min(.85, offset.dot(this.listenerRight) / Math.max(distance, 1))), now, .1);
    voice.rumble.gain.setTargetAtTime(.2 * level, now, .2);
    voice.roar.gain.setTargetAtTime(.16 * level, now, .2);
    voice.hiss.gain.setTargetAtTime(.07 * level ** 1.3, now, .2);
    voice.filter.frequency.setTargetAtTime(9000 / (1 + distance / 35), now, .2);
  }

  private scheduleBird(delay = 22 + Math.random() * 24): void {
    this.birdTimer = setTimeout(() => {
      if (!this.enabled || !this.context || document.hidden) return;
      const { daylight, night } = this.soundscape;
      if (this.immersion < .5) {
        if (Math.random() < daylight) this.gull();
        else if (Math.random() < night * 0.7) this.owl();
      }
      this.scheduleBird();
    }, delay * 1000);
  }

  /** Songbirds sing through the dawn chorus and only now and then by day. */
  private scheduleSong(delay?: number): void {
    const { chorus, daylight } = this.soundscape;
    const wait = delay ?? (chorus > 0.1 ? 1.2 + Math.random() * 4 / chorus : 9 + Math.random() * 16);
    this.songTimer = setTimeout(() => {
      if (!this.enabled || !this.context || document.hidden) return;
      if (this.immersion < .5 && Math.random() < Math.max(this.soundscape.chorus, this.soundscape.daylight * 0.3)) this.songbird();
      this.scheduleSong();
    }, (daylight + chorus > 0.05 ? wait : 12) * 1000);
  }

  /** Looks ahead a little and queues the next chirps on the audio clock. */
  private scheduleInsects = (): void => {
    if (!this.enabled || !this.context || document.hidden) return;
    const now = this.context.currentTime;
    if (this.immersion < .5 && this.insectLevel() > 0) {
      for (const cricket of this.ambience!.crickets) {
        if (cricket.next < now) cricket.next = now + Math.random() * cricket.period;
        while (cricket.next < now + 0.6) {
          const pulses = 3 + Math.floor(Math.random() * 2);
          for (let pulse = 0; pulse < pulses; pulse++) {
            const at = cricket.next + pulse * 0.036;
            cricket.pulse.gain.setValueAtTime(0, at);
            cricket.pulse.gain.linearRampToValueAtTime(0.006, at + 0.005);
            cricket.pulse.gain.linearRampToValueAtTime(0, at + 0.02);
          }
          // Crickets pause now and then, so the chorus never settles into a loop.
          cricket.next += cricket.period * (0.92 + Math.random() * 0.16) + (Math.random() < 0.06 ? 2 + Math.random() * 5 : 0);
        }
      }
    }
    this.insectTimer = setTimeout(this.scheduleInsects, 250);
  };

  private gull(): void {
    const context = this.context!;
    const pan = context.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.ambience!.wildlife);
    const start = context.currentTime + 0.1;
    const base = 680 + Math.random() * 240;
    for (let call = 0; call < 2; call++) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const at = start + call * 0.56;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(base * 0.8, at);
      oscillator.frequency.exponentialRampToValueAtTime(base * 1.3, at + 0.1);
      oscillator.frequency.exponentialRampToValueAtTime(base * 0.83, at + 0.44);
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(0.011 - call * 0.003, at + 0.07);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.48);
      oscillator.connect(envelope).connect(pan);
      this.playOnce(oscillator, at, at + .5, call === 1 ? [envelope, pan] : [envelope]);
    }
  }

  /** A few quick, rising and falling whistles. */
  private songbird(): void {
    const context = this.context!;
    const pan = context.createStereoPanner();
    pan.pan.value = Math.random() * 1.8 - 0.9;
    pan.connect(this.ambience!.wildlife);
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'sine';
    envelope.gain.value = 0;
    oscillator.connect(envelope).connect(pan);
    const base = 2300 + Math.random() * 1600;
    const notes = 3 + Math.floor(Math.random() * 5);
    const loudness = 0.0035 + Math.random() * 0.004;
    let at = context.currentTime + 0.05;
    for (let note = 0; note < notes; note++) {
      const length = 0.05 + Math.random() * 0.09;
      const from = base * (0.85 + Math.random() * 0.4), to = from * (Math.random() < 0.5 ? 1.35 : 0.7);
      oscillator.frequency.setValueAtTime(from, at);
      oscillator.frequency.exponentialRampToValueAtTime(to, at + length);
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(loudness, at + 0.012);
      envelope.gain.linearRampToValueAtTime(0, at + length);
      at += length + 0.03 + Math.random() * 0.07;
    }
    this.playOnce(oscillator, context.currentTime, at + 0.05, [envelope, pan]);
  }

  /** A soft, distant two-note hoot. */
  private owl(): void {
    const context = this.context!;
    const pan = context.createStereoPanner();
    pan.pan.value = Math.random() * 1.2 - 0.6;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 900;
    lowpass.connect(pan).connect(this.ambience!.wildlife);
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'triangle';
    envelope.gain.value = 0;
    oscillator.connect(envelope).connect(lowpass);
    const start = context.currentTime + 0.1;
    const base = 330 + Math.random() * 60;
    for (const [offset, length, pitch, level] of [[0, 0.32, 1.08, 0.016], [0.55, 0.62, 1, 0.02]]) {
      const at = start + offset;
      oscillator.frequency.setValueAtTime(base * pitch, at);
      oscillator.frequency.linearRampToValueAtTime(base * pitch * 0.94, at + length);
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(level, at + 0.08);
      envelope.gain.setTargetAtTime(0, at + length - 0.12, 0.05);
    }
    this.playOnce(oscillator, start, start + 1.4, [envelope, lowpass, pan]);
  }

  /** Play a one-shot call, then release its nodes. */
  private playOnce(source: OscillatorNode, start: number, stop: number, chain: AudioNode[]): void {
    source.start(start);
    source.stop(stop);
    source.onended = () => {
      source.disconnect();
      chain.forEach(node => node.disconnect());
    };
  }

  private clearSchedules(): void {
    clearTimeout(this.birdTimer);
    clearTimeout(this.songTimer);
    clearTimeout(this.insectTimer);
  }

  private visibilityChange = (): void => {
    if (!this.context || !this.enabled) return;
    if (document.hidden) {
      this.clearSchedules();
      void this.context.suspend();
    } else {
      void this.resume(this.request).catch(() => {});
    }
  };
}
