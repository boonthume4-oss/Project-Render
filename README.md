# Arch Prompt Studio

Builds structured Thai/English prompts for AI architectural rendering from a source photo, reference images and preset options. See `SPEC.md` for the full product spec and `ARCHITECTURE.md` for the module contract.

## Run

```bash
npm install
cp .env.example .env      # then set ANTHROPIC_API_KEY=... for real image analysis
npm run dev               # web on http://localhost:5173, API on http://localhost:8787
```

### Single HTML file

`arch-prompt-studio.html` is the whole app in one file (rebuild with `npm run build:single`).

- **Double-click the file:** everything works offline except AI image analysis.
- **Double-click `start.bat`:** starts the server and opens http://localhost:8787 — the same file, with AI image analysis (needs Node.js and `ANTHROPIC_API_KEY` in `.env`).

Each way of opening keeps its own saved data in the browser (file, localhost:8787 and the dev server on 5173 are different origins); use preset export/import to move settings.

Other scripts: `npm test` (vitest), `npm run build`, `npm run typecheck`, `npm run lint`.

Without `ANTHROPIC_API_KEY` the app runs in Demo Mode: every manual feature works, image analysis is disabled and says so — no simulated results are shown.

## Status

Works now: the full editor (locks, references, materials, camera, lighting, effects, landscape, hardscape, foreground, vehicles, people/animals), prompt assembly in TH/EN at 4 detail levels, validation and negative library, copy/export/clear/undo, custom option management, history, presets, light/dark, responsive layout, local persistence (localStorage + IndexedDB for images).

Needs an API connection:
- Image analysis (source + references) — implemented against Claude Vision in `server/adapters/anthropic.ts`; requires `ANTHROPIC_API_KEY`. Not yet exercised against the live API.
- Image generation — `POST /api/generate` returns 501; `server/adapters/types.ts` defines the `GenerationAdapter` interface to implement.

A text prompt cannot guarantee exact preservation of geometry or vehicle models; that needs an engine with image-to-image, masks, depth or ControlNet.
