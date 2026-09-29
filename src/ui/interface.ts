import './style.css';
import './settings.css';
import type { IslandAudio } from '../audio/audio';
import { isQualityLevel, type QualityLevel } from '../quality';
import { countries, dayGradient, type DayClock } from '../sky/clock';
import { loadSetting, saveSetting } from '../storage';

const FRAME_RATE_KEY = 'coconuts.frame-rate';

// The markup lives in index.html.
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const ready = () => document.documentElement.dataset.ready === 'true';

/**
 * The loading cover, shown at startup and while a quality change prepares its shaders.
 * Steps are named with their typical duration in milliseconds, which weights the bar.
 */
export function createLoader<Step extends string>(steps: Record<Step, number>) {
  const loader = $('#loader'), root = $('#interface'), progress = $('#loading');
  const label = $('#loading-step'), percentage = $('#loading-percent'), fill = $('#loading-fill');
  let plan: Record<string, number> = steps;

  function show(step: string, fraction: number) {
    const percent = Math.floor(fraction * 100);
    label.textContent = step;
    percentage.textContent = `${percent}%`;
    fill.style.transform = `scaleX(${fraction})`;
    progress.setAttribute('aria-valuenow', String(percent));
    progress.setAttribute('aria-valuetext', `${step}, ${percent}%`);
  }

  return {
    /** Start over with some of the steps, as when a quality change prepares only its shaders. */
    plan<Some extends Step>(next: Record<Some, number>) {
      plan = next;
      // Empty the bar without sliding back.
      fill.style.transition = 'none';
      fill.style.transform = 'scaleX(0)';
      fill.getBoundingClientRect();
      fill.style.transition = '';
    },
    /** Show a step with the work finished before it, and present it before the step's synchronous work. */
    async step(name: Step) {
      let done = 0, total = 0;
      for (const [step, ms] of Object.entries(plan)) {
        if (step === name) done = total;
        total += ms;
      }
      show(name, done / total);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    cover() {
      document.documentElement.dataset.ready = 'false';
      root.inert = true;
      $<HTMLSelectElement>('#quality').disabled = true;
      loader.classList.remove('loaded');
      loader.classList.add('preparing');
    },
    uncover() {
      show(label.textContent!, 1);
      root.inert = root.classList.contains('hidden');
      $<HTMLSelectElement>('#quality').disabled = false;
      loader.classList.add('loaded');
      loader.classList.remove('preparing');
      document.documentElement.dataset.ready = 'true';
    },
    fail(error: unknown) {
      console.error('The island could not start:', error);
      loader.classList.remove('loaded');
      loader.classList.add('error');
      $('#loader h2').textContent = 'The island is just out of reach.';
      $('#error-message code').textContent = error instanceof Error ? error.message : String(error);
      $('#retry').addEventListener('click', () => location.reload(), { once: true });
    },
  };
}

interface InterfaceOptions {
  audio: IslandAudio;
  clock: DayClock;
  quality: QualityLevel;
  changeQuality(level: QualityLevel): void;
  capture(): void;
  returnHome(): void;
  openAgentSetup?(): void;
  /** The panel keeps the cursor free while it is open. */
  onPanelChange(open: boolean): void;
}

/** Corner buttons, the settings panel, the toast, and the interface's keyboard shortcuts. */
export function createInterface({ audio, clock, quality, changeQuality, capture, returnHome, openAgentSetup, onPanelChange }: InterfaceOptions) {
  const root = $('#interface'), panel = $('#settings'), panelToggle = $('#settings-toggle');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function toast(message: string) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('visible'), 3700);
  }

  function openPanel(open: boolean) {
    const hadFocus = panel.contains(document.activeElement);
    panel.classList.toggle('open', open);
    panel.inert = !open;
    panelToggle.setAttribute('aria-expanded', String(open));
    panelToggle.classList.toggle('active', open);
    onPanelChange(open);
    if (open) {
      renderDay();
      panel.querySelector<HTMLButtonElement>('.close-panel')!.focus({ preventScroll: true });
    } else if (hadFocus) panelToggle.focus({ preventScroll: true });
  }
  const closePanel = () => openPanel(false);
  panelToggle.addEventListener('click', () => openPanel(!panel.classList.contains('open')));
  panel.querySelector('.close-panel')!.addEventListener('click', closePanel);
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  });

  let hidden = false;
  function setHidden(value: boolean) {
    hidden = value;
    closePanel();
    root.classList.toggle('hidden', hidden);
    root.inert = hidden;
    $('#show-ui').classList.toggle('visible', hidden);
  }
  $('#hide-ui').addEventListener('click', () => setHidden(true));
  $('#show-ui').addEventListener('click', () => setHidden(false));

  // Browser autoplay may wait for a gesture; keep the button responsive meanwhile.
  const soundButton = $('#sound');
  let sound = true, soundRequest = 0;
  const renderSound = () => {
    soundButton.setAttribute('aria-pressed', String(sound));
    soundButton.setAttribute('aria-label', `${sound ? 'Disable' : 'Enable'} island sounds`);
  };
  function setSound(enabled: boolean) {
    const request = ++soundRequest;
    sound = enabled;
    renderSound();
    void audio.setEnabled(enabled).catch(() => {
      if (request !== soundRequest) return;
      sound = false;
      renderSound();
      void audio.setEnabled(false);
      toast('Sound couldn’t start. Give it another try.');
    });
  }
  soundButton.addEventListener('click', () => setSound(!sound));
  setSound(true);
  const volume = $<HTMLInputElement>('#volume');
  volume.addEventListener('input', () => {
    audio.setVolume(Number(volume.value) / 100);
    $('#volume-label').textContent = `${volume.value}%`;
    volume.style.setProperty('--volume', `${volume.value}%`);
  });

  const slider = $<HTMLInputElement>('#time'), liveButton = $('#time-now');
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
  let shownMinute = -1;
  function renderTime() {
    const minute = Math.floor(clock.minutes);
    if (minute === shownMinute) return;
    shownMinute = minute;
    const label = timeFormat.format(new Date(2000, 0, 1, 0, minute));
    $('#time-label').textContent = label;
    slider.setAttribute('aria-valuetext', label);
    slider.value = String(minute);
  }
  function renderLive() {
    liveButton.setAttribute('aria-pressed', String(clock.live));
    liveButton.title = clock.live ? 'Following the current sky' : 'Back to the current sky';
    shownMinute = -1;
    renderTime();
  }
  function renderDay() {
    slider.style.setProperty('--day', dayGradient(clock.country));
    panel.querySelectorAll('.time-scale span').forEach((span, i) => span.textContent = hourFormat.format(new Date(2000, 0, 1, i * 6)));
  }
  slider.addEventListener('input', () => { clock.set(Number(slider.value)); renderLive(); });
  liveButton.addEventListener('click', () => { clock.sync(); renderLive(); });
  const countrySelect = $<HTMLSelectElement>('#sky-country');
  countrySelect.append(...countries.map(country => new Option(country.name, country.code)));
  countrySelect.value = clock.country.code;
  countrySelect.addEventListener('change', () => {
    const country = countries.find(country => country.code === countrySelect.value);
    if (!country) return;
    clock.setCountry(country);
    renderDay();
    renderLive();
  });
  renderDay();
  renderLive();

  const qualitySelect = $<HTMLSelectElement>('#quality');
  qualitySelect.value = quality;
  qualitySelect.addEventListener('change', () => {
    if (isQualityLevel(qualitySelect.value)) changeQuality(qualitySelect.value);
  });

  // The frame rate is averaged over half a second; a pause (preparing a preset, a hidden window) restarts the sample.
  const frameRateToggle = $<HTMLInputElement>('#show-frame-rate'), frameRate = $('#frame-rate');
  let frames = 0, sampleStart = 0, lastFrame = 0;
  function showFrameRate(show: boolean) {
    frameRateToggle.checked = show;
    frameRate.hidden = !show;
    frameRate.textContent = '';
    lastFrame = 0;
  }
  function countFrame(now: number) {
    if (frameRate.hidden) return;
    if (now - lastFrame > 1000) { sampleStart = now; frames = 0; } else frames++;
    lastFrame = now;
    if (now - sampleStart < 500) return;
    frameRate.textContent = `${Math.round(frames * 1000 / (now - sampleStart))} fps`;
    sampleStart = now;
    frames = 0;
  }
  frameRateToggle.addEventListener('change', () => {
    showFrameRate(frameRateToggle.checked);
    saveSetting(FRAME_RATE_KEY, String(frameRateToggle.checked));
  });
  showFrameRate(loadSetting(FRAME_RATE_KEY) === 'true');

  $('#capture').addEventListener('click', capture);
  if (openAgentSetup) {
    const setupButton = $('#agent-setup');
    setupButton.hidden = false;
    setupButton.addEventListener('click', openAgentSetup);
  }

  window.addEventListener('keydown', event => {
    if (!ready() || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('input, select, textarea')) return;
    if (event.code === 'KeyH') setHidden(!hidden);
    if (event.code === 'KeyP') capture();
    if (event.code === 'Escape') setHidden(false);
    if (event.code === 'Home') {
      event.preventDefault();
      closePanel();
      returnHome();
    }
  });

  return {
    toast,
    closePanel,
    get panelOpen() { return panel.classList.contains('open'); },
    get hidden() { return hidden; },
    /** A letter or dialog covers the island: fade the corner interface out. */
    setReading(reading: boolean) {
      if (reading) closePanel();
      root.classList.toggle('reading', reading);
    },
    /** Keep the time readout and the frame rate in step with the loop. */
    update(now: number) {
      renderTime();
      countFrame(now);
    },
  };
}
