# Coconuts

A small tropical island where you can swim, explore, walk while your agents work. A boat with a message in a bottle will let you comunicate with your agents while you stay on the island.

## Getting started

```sh
npm install
npm run dev
```

## Controls

| Key | What it does |
| --- | --- |
| WASD / arrows | Walk or swim |
| Shift | Go faster |
| Mouse | Look around |
| Scroll | Move forward or back |
| Click | Lock the mouse so you can turn freely. Escape releases it |
| F | Sit or lie down near furniture. Press it again to get up |
| H | Hide or show the interface |
| P | Save a postcard (PNG) |

Time and sky: The island runs on real solar time. The Time slider lets you jump to any hour, and **Now** brings you back to the present. It also has real night sky / stars!

## Desktop app

```sh
npm run desktop:package
mv release/mac-arm64/Coconuts.app/ /Applications
```

The macOS app connects the island to your coding agents at startup