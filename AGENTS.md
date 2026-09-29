# Coconuts

An immersive tropical island experience built with TypeScript, Three.js, TSL materials, and Vite. The macOS desktop app uses Electron and connects to coding agents. Rendering requires desktop WebGPU.

## Project layout

- `src/main.ts`: assembles the island, prepares quality presets, and runs the frame loop.
- `src/sky/`: sun, moon and stars, the shared light model, clouds, and the day clock.
- `src/water/`: sea state (wind chop, swell), surf and swash simulation, water optics above and below the surface, caustics, and underwater light.
- `src/land/`: terrain, ground, rocks, vegetation, the waterfall, and birds.
- `src/structures/`: pier, boardwalks, torches, bungalow, and boats, built with `PartBuilder`.
- `src/reef/`: seabed, coral, fish, turtles, and rays.
- `src/player/`: controls, collisions, rowing, and resting spots.
- `src/render/`: renderer, post-processing, shader preloading, lamp slots, and billboard particles.
- `src/audio/`, `src/ui/` (interface in `index.html`), `src/agents/` (message boat and desktop bridge).
- `src/quality.ts`: every value a visual preset changes.
- `desktop/`: Electron app, agent hooks, and integrations; see its README.
- `public/`: static assets. `references/`: visual references.

## Working guidelines

- Keep code readable and Markdown concise.
- Match the island's natural visual style. Keep interface elements small and unobtrusive.

## Commands and validation

- Do not add tests
- Do not take screenshots to check the changes, unless instructed
- Use Blender if needed to create / edit assets
