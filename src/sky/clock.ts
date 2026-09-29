import countries from '../data/countries.json';
import { loadSetting, saveSetting } from '../storage';
import { DAY, elevation, minutesNow, skyAt, todayAt } from './celestial';

export { countries };
type Country = typeof countries[number];

const COUNTRY_KEY = 'coconuts.sky-country';
const DEFAULT_COUNTRY = 'SC';

function loadCountry(): Country {
  const code = loadSetting(COUNTRY_KEY) ?? DEFAULT_COUNTRY;
  return countries.find(country => country.code === code) ?? countries.find(country => country.code === DEFAULT_COUNTRY)!;
}

/** Solar time at the chosen sky location. A chosen time is an offset from now, so the sky always runs at real speed. */
export class DayClock {
  live = true;
  country = loadCountry();
  private offset = 0;
  private shownOffset = 0;

  get minutes() { return minutesNow(new Date(Date.now() + this.offset), this.country); }

  set(minutes: number) {
    const displayed = new Date(Date.now() + this.shownOffset);
    const requested = todayAt(minutes, displayed, this.country);
    // Crossing midnight should move a few minutes, not rewind an entire day.
    // Keep the date continuous too, so the moon and stars follow the same arc.
    const delta = ((requested.getTime() - displayed.getTime() + DAY * 1.5) % DAY) - DAY * .5;
    this.live = false;
    this.offset = this.shownOffset + delta;
  }

  setCountry(country: Country) {
    const minutes = this.minutes;
    this.country = country;
    saveSetting(COUNTRY_KEY, country.code);
    if (!this.live) this.set(minutes);
  }

  sync() {
    this.live = true;
    this.offset = 0;
  }

  /** Advance toward the chosen time; smooth changes glide instead of jumping. */
  update(dt: number, smooth: boolean) {
    const gap = this.offset - this.shownOffset;
    this.shownOffset = smooth && Math.abs(gap) > 10 ? this.shownOffset + gap * (1 - Math.exp(-3.2 * dt)) : this.offset;
    return new Date(Date.now() + this.shownOffset);
  }
}

/** CSS gradient of today's sky colors at the country, for the time slider. */
export function dayGradient(country: Country, today = new Date()) {
  const stops: string[] = [];
  for (let hour = 0; hour <= 24; hour += .5) {
    const e = elevation(skyAt(todayAt(hour * 60, today, country), country).sun);
    const twilight = Math.min(1, Math.max(0, (e + 12) / 12)), day = Math.min(1, Math.max(0, (e - 1) / 12));
    const color = day > 0
      ? `color-mix(in oklab, #e9a77c, #8fcbe6 ${Math.round(day * 100)}%)`
      : `color-mix(in oklab, #17243f, #e9a77c ${Math.round(twilight * 100)}%)`;
    stops.push(`${color} ${(hour / 24 * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
