# Redesign brief — "show, don't tell"

User feedback (Thai, paraphrased): features are complete but the app is hard to use — too much text, visually noisy, no focus, and it takes too long to reach a finished prompt.
Requests:
1. Explain with **infographics instead of text**.
2. **Transliterated Thai words (คำทับศัพท์) → just write the English word** (e.g. พรอมต์ → Prompt, เลนส์ → Lens, เรนเดอร์ → Render, โหมด → Mode, สไตล์ → Style, พรีเซ็ต → Preset, ฟาซาด → Facade, ทราเวอร์ทีน → Travertine, คอนกรีต → Concrete, แลนด์สเคป → Landscape, เวกเตอร์..., Negative, Reference/ภาพอ้างอิง stays Thai because it is a real Thai word). Real Thai words stay Thai (ล็อก is transliterated → Lock; วัสดุ, แสง, กล้อง, ท้องฟ้า, ถนน, สวน, รถ, คน stay Thai).
3. **Auto-collapse**: working in one section collapses all others automatically; a collapsed section still shows **what has been selected** in it (summary chips on its header).
4. **Typography, sizes, weights and overall page style like the user's website** (`E:\WEB\website\index.html`, `css/base.css`, `css/sections.css`, `css/navigation.css`, `css/components.css`).
5. Reaching a finished prompt must be **fast**.

## Visual language (from the website)
- Background `#f5f5f7` (dark `#000`), cards `#fff` (dark `#1d1d1f`), ink `#1d1d1f / #4f4f57 / #86868b`, hairline `rgba(29,29,31,.1)`, accent blue `#0071e3` (dark `#2997ff`). Ambient body glow: soft radial gradients of blue + faint pink (NO indigo/purple as accent — the app spec forbids purple; a barely visible glow is the limit).
- Fonts: EN `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', sans-serif`; TH `'Noto Sans Thai', <same>` (Google Fonts link 400–800 in index.html; offline falls back gracefully). `html[lang=th]` switches body font to TH.
- Type scale: kicker/eyebrow 11px / 600 / uppercase / letter-spacing .16em / ink3. Section title 22–28px / 700 / letter-spacing -.03em (page-level hero titles up to 40px). Body 14–15px / 400 / line-height 1.5 (TH 1.6, letter-spacing 0). Labels 12–13px / 600. Big numbers 26–38px / 650 / -.03em.
- Shapes: cards radius 22px (small 14px), pills radius 980px for buttons/chips/segmented controls, glass top nav 52px with `backdrop-filter: saturate(145%) blur(16px)`, shadows `--shadow-sm/md/lg` from the site.
- Buttons: pill, 14px/700, primary = solid blue, ghost = hairline border.

## UX rules
- Max ~6 words of helper text visible at a time per block; anything longer goes into an `InfoTip` (ⓘ icon → popover).
- Every explanation that can be a picture is a picture: icons + 1–3 word captions, diagrams, meters, dials.
- Collapsed section header = icon · step number · title · **summary chips** (from `sectionSummary`) · status dot (empty / partial / done).
- Sidebar groups sections into 3 phases: **Input** (mode, source, analysis, references) · **Design** (locks … people) · **Output** (validation, output). Same summary chips in compact form.
- Each expanded section ends with a **Next →** pill button that opens the next section (auto-collapsing the current one).
- Declarative sections show **Essentials** first; fine controls (`field.advanced`) are behind an "Advanced" disclosure (`ui.showAdvanced[sectionId]`).
- Fast path: top of the workspace shows a **Quick Start** strip: ① Preset ② Upload ③ Analyze (auto Apply) ④ Copy — each a big visual tile with status.
- Analysis result: after a successful analysis, auto "Apply to Form" (user can un-apply).

## New shared APIs (owned by module `visual`, path `src/components/visual/`)
```ts
// Stepper.tsx — horizontal workflow progress for the 7 steps / 3 phases; click jumps to section
export function Stepper(props: { compact?: boolean }): JSX.Element
// PositionGrid.tsx — 3×3 clickable scene grid (rows: background/midground/foreground, cols: left/center/right)
//   value = position option id (position-foreground, position-left, …, position-center) or combos 'position-foreground-left' etc.
export function PositionGrid(props: { value: string; onChange: (id: string) => void; size?: number }): JSX.Element
// SunCompass.tsx — 8-way dial around a tiny building icon; value is an option id from 'sun-direction' or free text
export function SunCompass(props: { value: string | null; onChange: (v: string | null) => void }): JSX.Element
// TimeOfDayBar.tsx — gradient strip (dawn → morning → midday → golden → blue hour → night) with clickable stops
export function TimeOfDayBar(props: { category: string; value: string | null; onChange: (v: string | null) => void }): JSX.Element
// FovWedge.tsx — focal-length chips drawn as a camera with field-of-view wedge that narrows as mm grows
export function FovWedge(props: { value: string | null; onChange: (v: string | null) => void }): JSX.Element
// LevelMeter.tsx — segmented meter (0–100 or min–max) with icons at both ends
export function LevelMeter(props: { value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; lowIcon?: IconName; highIcon?: IconName; label?: string }): JSX.Element
// SceneLockMap.tsx — schematic SVG of a scene (camera, building, materials, site/road, sky) — each zone clickable,
//   colored by lock state of its LOCK_ELEMENTS group (none / partial / all locked); click cycles Editable → Locked → Enhance
export function SceneLockMap(props: { onSelectGroup?: (group: LockElementDef['group']) => void }): JSX.Element
// LockLegend.tsx — row of the 5 lock-state icons with 1-word captions
export function LockLegend(): JSX.Element
// ConfidenceBar.tsx — thin bar 0..1 with color (red < .5 < amber < .75 < green)
export function ConfidenceBar(props: { value: number | null }): JSX.Element
// SummaryChips.tsx — renders SummaryItem[] as tiny pills (max N + "+k")
export function SummaryChips(props: { items: SummaryItem[]; max?: number }): JSX.Element
// InfoTip.tsx — ⓘ button with popover text (hover/focus/tap), for moving paragraphs out of the way
export function InfoTip(props: { text: string; label?: string }): JSX.Element
// StatusDot.tsx
export function StatusDot(props: { status: SectionStatus }): JSX.Element
```

## Summary service (module `summary`, `src/services/sectionSummaryService.ts`)
```ts
export type SectionStatus = 'empty' | 'partial' | 'done' | 'warning';
export interface SummaryItem { label: string; icon?: IconName; tone?: 'default' | 'lock' | 'ref' | 'auto' | 'warn' }
export function sectionSummary(id: SectionId, project: Project, ov: OptionOverrides, lang: Lang): SummaryItem[]
export function sectionStatus(id: SectionId, project: Project, ov: OptionOverrides): SectionStatus
export function useSectionSummary(id: SectionId): { items: SummaryItem[]; status: SectionStatus }
```
Labels are short (option labels, counts like "3 refs", "31 🔒" → use icon 'lock' + "31").

## Module ownership (redesign)
| Module | Files |
|---|---|
| style-shell | `src/styles/**`, `index.html`, `src/App.tsx`, `src/components/layout/**`, `src/hooks/**`, `src/i18n/strings/shell.ts`, `src/store/defaults.ts`, `src/store/store.ts` (UI migration only) |
| visual | `src/components/visual/**`, `src/components/common/**`, `src/i18n/strings/common.ts` |
| summary | `src/services/sectionSummaryService.ts`, `src/services/__tests__/sectionSummary.test.ts` |
| language | `src/data/**`, `src/i18n/strings/analysis.ts`, `entities.ts`, `prompt.ts` (text only — keys unchanged) |
| sections | `src/sections/**` (+ css) |
| prompt-ui | `src/components/prompt/**`, `src/pages/**` |
