type SurfVoice = { offset: number; body: GainNode; wash: GainNode; retreat: GainNode; filter: BiquadFilterNode; pan: StereoPannerNode };
type Cricket = { pulse: GainNode; period: number; next: number };

export type Ambience = ReturnType<typeof createAmbience>;

/**
 * The continuous sound bed: sea and air above the surface, a muffled water
 * body below it, five surf voices along the shore, the waterfall, and gated crickets.
 */
export function createAmbience(context: AudioContext, destination: AudioNode) {
  const surfVoices: SurfVoice[] = [];
  const crickets: Cricket[] = [];
  const surface = context.createGain();
  const surfaceFilter = context.createBiquadFilter();
  surfaceFilter.type = 'lowpass'; surfaceFilter.Q.value = .5;
  surfaceFilter.connect(surface).connect(destination);
  const wildlife = context.createGain();
  wildlife.connect(surfaceFilter);
  const underwater = context.createGain();
  const underwaterFilter = context.createBiquadFilter();
  underwaterFilter.type = 'lowpass'; underwaterFilter.Q.value = .45;
  underwaterFilter.connect(underwater).connect(destination);

  const noise = makeAmbientNoise(context);
  const layer = (low: number, high: number, gain: number, offset: number, destination: AudioNode = surfaceFilter): GainNode => {
    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = low;
    highpass.Q.value = 0.5;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = high;
    lowpass.Q.value = 0.35;
    const envelope = context.createGain();
    envelope.gain.value = gain;
    source.connect(highpass).connect(lowpass).connect(envelope).connect(destination);
    source.start(0, offset);
    return envelope;
  };
  layer(35, 240, .085, 0);
  layer(1700, 4200, .009, 9.1);

  // Independent offsets of seamless stereo noise make a diffuse water bed.
  // Slow gain drift adds movement without bubbles, breathing or tonal calls.
  const depthBody = layer(28, 210, .24, 3.8, underwaterFilter);
  const waterHush = layer(120, 740, .11, 7.1, underwaterFilter);
  layer(480, 1300, .023, 12.4, underwaterFilter);
  for (const [envelope, frequency, amount] of [[depthBody, .039, .035], [waterHush, .057, .014]] as const) {
    const drift = context.createOscillator(), range = context.createGain();
    drift.frequency.value = frequency; range.gain.value = amount;
    drift.connect(range).connect(envelope.gain);
    drift.start();
  }
  for (const [index, offset] of [-30, -15, 0, 15, 30].entries()) {
    const pan = context.createStereoPanner();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 3500; filter.Q.value = .4;
    filter.connect(pan).connect(surfaceFilter);
    surfVoices.push({ offset, pan, filter,
      body: layer(65, 1200, 0, index * 2.37, filter),
      wash: layer(450, 6500, 0, index * 1.81 + .9, filter),
      retreat: layer(1100, 8000, 0, index * 2.13 + 1.7, filter),
    });
  }

  // The plunge's broadband roar: a low rumble, the body of the roar, and spray hiss.
  const fallsPan = context.createStereoPanner();
  const fallsFilter = context.createBiquadFilter();
  fallsFilter.type = 'lowpass'; fallsFilter.frequency.value = 6000; fallsFilter.Q.value = .4;
  fallsFilter.connect(fallsPan).connect(surfaceFilter);
  const falls = {
    pan: fallsPan, filter: fallsFilter,
    rumble: layer(40, 380, 0, 5.3, fallsFilter), roar: layer(280, 2600, 0, 8.7, fallsFilter), hiss: layer(2000, 9000, 0, 11.2, fallsFilter),
  };

  // Each cricket is a steady tone gated into short trilled chirps.
  const insects = context.createGain();
  insects.gain.value = 0;
  insects.connect(wildlife);
  for (const [pitch, pan, period] of [[4350, -0.55, 0.62], [4720, 0.4, 0.81], [5080, 0.75, 0.53], [3980, -0.15, 1.1]]) {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = pitch;
    const pulse = context.createGain();
    pulse.gain.value = 0;
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    oscillator.connect(pulse).connect(panner).connect(insects);
    oscillator.start();
    crickets.push({ pulse, period, next: 0 });
  }

  return {
    wildlife, surfVoices, falls, insects, crickets,
    setImmersion(immersion: number, waterDepth: number, immediate = false) {
      const now = context.currentTime;
      const depth = Math.min(1, waterDepth / 24);
      const air = (1 - immersion) ** 2;
      const set = (parameter: AudioParam, value: number) => {
        if (immediate) {
          parameter.cancelScheduledValues(now);
          parameter.setValueAtTime(value, now);
        } else {
          parameter.setTargetAtTime(value, now, .24);
        }
      };
      // Keep a trace of low surf while silencing discrete wildlife calls.
      set(surface.gain, .035 + .965 * air);
      set(surfaceFilter.frequency, 20000 * (.02 ** immersion));
      set(wildlife.gain, air);
      set(underwater.gain, Math.sin(immersion * Math.PI * .5) * (1 - depth * .12));
      set(underwaterFilter.frequency, 1150 - depth * 470);
    },
  };
}

function makeAmbientNoise(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * 14);
  const overlap = Math.floor(context.sampleRate * 0.2);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    const raw = new Float32Array(length + overlap);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
    for (let index = 0; index < raw.length; index++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      brown = (brown + white * 0.02) / 1.02;
      raw[index] = pink * 0.7 + brown * 1.5;
    }
    data.set(raw.subarray(0, length));
    // The tail continues into this overlapping head, so the loop has no cut.
    for (let index = 0; index < overlap; index++) {
      const t = index / (overlap - 1);
      const smooth = t * t * (3 - 2 * t);
      data[index] = raw[length + index] * (1 - smooth) + raw[index] * smooth;
    }
  }
  return buffer;
}
