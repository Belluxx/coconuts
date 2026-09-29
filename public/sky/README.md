# Sky data

Everything the sky needs is in this folder, so it works offline. It never asks for your location. The country you pick is saved in the browser.

## Where the data comes from

**Stars:** `hyg-stars.json` holds the 8,920 stars from the [HYG database v4.1](https://github.com/astronexus/HYG-Database) (David Nash / Astronexus) that are bright enough to see by eye, meaning magnitude 6.5 or brighter. The Sun is left out. Each row has right ascension in hours, declination in degrees, magnitude, and B−V color. B−V is 0.65 when it's missing. Licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), see `HYG-LICENSE.txt`.

**Milky Way:** `milky-way.webp` comes from NASA's [Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851/) (NASA Goddard SVS, Ernie Wright). It's the 4K EXR converted to sRGB and saved as WebP at quality 92, at 4096 × 2048. The map leaves out the bright stars because those are drawn from HYG. It uses J2000 coordinates, with RA 0h in the middle, RA increasing to the left, and north at the top. See NASA's [usage guidelines](https://svs.gsfc.nasa.gov/help/).

**Countries:** `src/data/countries.json` is cut down from [mledoze/countries](https://github.com/mledoze/countries). It keeps only the code, name, and rough center of 250 countries and territories. These are geographic centers, not capitals. Licensed ODbL 1.0, see `COUNTRIES-LICENSE.txt`.

All sources were downloaded on 2026-09-27. The script that built these files, `scripts/prepare-sky-assets.mjs`, has been removed from the repo. You can still find it in git history, for example at commit `10bdca1`.

## How accurate it is

Accurate enough to look right, but not for real astronomy.

- The sky turns once every sidereal day, about 23 h 56 m 4 s, even when you've picked a custom time.
- Star positions use sidereal time and IAU 1976 precession from J2000. UTC stands in for UT1.
- There's no proper motion, atmospheric refraction, or lunar parallax. The Sun and Moon use simple, low-precision formulas.
- Local time is solar time, meaning UTC plus 4 minutes for each degree of longitude. Time zones and daylight saving are ignored.

The default location is the Seychelles. When you pick a different country, both the horizon and the celestial pole move. If you're following the live clock, it stays on the current moment. If you picked a time by hand, it keeps that local hour.
