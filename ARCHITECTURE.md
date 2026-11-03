# AI Architectural Rendering Prompt Studio — Architecture Contract

React 19 + TypeScript (strict, `verbatimModuleSyntax` → use `import type`) + Vite 6 + CSS Modules.
Backend: Node/Express proxy in `server/` (port 8787), Vite proxies `/api`. Vision provider: Anthropic Claude via `@anthropic-ai/sdk` (key in `.env`, never in frontend).

The full product spec is `SPEC.md`. **Read the parts relevant to your module.**

## Already written (do not rewrite; extend only if strictly needed and say so)

| File | Purpose |
|---|---|
| `src/types/index.ts` | ALL domain types (Project, ManualData, AutoData, LockSetting, ReferenceImage, PromptOption, SectionDef/FieldDef, ValidationIssue, NegativeCategory, PromptOutput, HistoryEntry, Preset, UIState…) |
| `src/store/store.ts` | `useApp(selector)`, `store.getState()`, `actions.updateProject(draft => …, {coalesceKey?, undoable?})`, `actions.undo/redo/replaceProject/setUI/updateOptions/setHistory/setPresets/saveNow/toast(text, kind)`. Undo stacks: `state.past/future`. `state.saveStatus`. |
| `src/store/defaults.ts` | `createProject()`, `emptyAuto()`, `emptyManual()`, `defaultUI()`, `defaultPlacement()`, `DEFAULT_SECTION_ORDER`, `AUTO_FIELD_KEYS` (analysis path → field key) |
| `src/store/selectors.ts` | `resolveField(project, key, refCategory?, lang = 'en')` → `{value, source: 'manual'\|'reference'\|'auto'\|'none'}` (Manual > Reference > Auto; `lang` only picks the Thai mirror text — `valueTh` / `descriptionTh` — with English fallback), `lockOf`, `isPreserved`, `isEmptyValue`; bilingual analysis helpers `autoValueIn`, `refDescriptionIn`, `refSummaryIn`, `refUncertaintiesIn`, `objectTextIn`, `knownObjectTextIn` (English decides unknown), `summaryIn`, `uncertaintiesIn` (a Thai list is used only when its item count matches the English list), `isAutoUsableIn` / `isConfirmedIn` (`confirmedTh` = Thai-only confirmation, never confirms the English text), `applyAutoEdit` (inline edit: editing English drops stale `valueTh`; Thai typed in the Thai UI goes to `valueTh` only) |
| `src/services/storageService.ts` | `storageService.getJSON/setJSON/remove/clearAll/estimate`, `imageStore.put/get/delete/keys/clear` (IndexedDB blobs), `getImageUrl(key)`, `revokeImageUrl(key)`, `StorageQuotaError` |
| `src/services/optionService.ts` | `OptionSeed` tuple type, `DEFAULT_OPTIONS`, `getOptions(cat, ov)`, `findOption`, `optionPhrase(idOrText, lang, ov)`, `optionLabel`, `useOptions(cat)`, `optionActions.add/edit/duplicate/remove/reorder/move/resetCategory/restoreDefaults` |
| `src/i18n/index.ts` | `useT()` → `{lang, t(key, vars?), L(bilingual)}`, `translate(lang,key,vars)`, `pick(lang, b)`, `Dict` type. Strings auto-merged from `src/i18n/strings/*.ts` (`export const strings: Dict = {...}`) |
| `src/styles/tokens.css` | CSS variables + primitive classes: `.btn .btn-primary .btn-ghost .btn-danger .btn-sm .icon-btn .chip(.is-active/.is-custom, aria-pressed) .field .field-label .input .select .textarea .card .glass .badge(.badge-auto/-manual/-reference/-warning/-danger) .row .wrap .stack .grow .muted .divider .scroll-y .sr-only` |
| `src/sections/registry.tsx` | SectionId → component map (fixed file paths below) |
| `src/utils/id.ts` | `uid(prefix)`, `nowIso()`, `deepClone()` |

## Global rules
- Data separation: Auto analysis lives in `project.auto` ONLY; everything the user enters/selects lives in `project.manual` ONLY. Clearing one never touches the other.
- Manual > Reference > Auto (use `resolveField`). Explicit Lock > Reference. Reference only applies to categories the user allowed.
- Every visible button/menu MUST have a working handler. No fake analysis results — if the backend/key is missing, show a clear "Demo / not connected" state.
- Every UI string goes through `t()` with keys in your own `src/i18n/strings/<module>.ts` (prefix keys with your module name, e.g. `vehicles.addVehicle`). Provide both th and en. Inline `Bilingual` objects (`{th,en}`) are fine for data.
- Styling: CSS Modules next to components (`Foo.module.css`) using tokens; global primitives from tokens.css. Light/Dark via tokens. No purple. Minimal line icons via `<Icon name=… />`. Compact flat horizontal chips, no oversized buttons. Responsive (≥320px).
- Accessibility: buttons have `aria-label`/`title` when icon-only (use `<Tooltip>` or `title`), keyboard operable, visible focus.
- Section components take NO props and read/write the store directly.
- Lists of entities use `uid()` ids.
- No new npm dependencies without strong need (none expected). Native HTML5 drag & drop / pointer events for drag.

## Shared component APIs (owned by module `common-ui`, path `src/components/common/`)
Every module may import these; code against exactly these signatures.

```ts
// Icon.tsx
export function Icon(props: { name: IconName; size?: number; className?: string; strokeWidth?: number }): JSX.Element
// Tooltip.tsx — wraps a child, shows label on hover/focus (also sets aria-label if child lacks one)
export function Tooltip(props: { label: string; children: React.ReactElement; side?: 'top'|'bottom'|'left'|'right' }): JSX.Element
// IconButton.tsx
export function IconButton(props: { icon: IconName; label: string; onClick?: (e: React.MouseEvent) => void; pressed?: boolean; disabled?: boolean; size?: number; className?: string }): JSX.Element
// ChipGroup.tsx — option-library chips with FULL option management:
//   search box (when > 8 options), group headers, Add Option (inline form th/en/value), right-click context menu
//   (Edit, Duplicate, Delete, Move Up, Move Down) on every option (defaults: delete = hide), long-press / "⋯" button
//   on touch for the same menu, HTML5 drag-to-reorder, footer menu: Reset Category, Restore Default Options,
//   None (clears selection), Select All (multi only).
export function ChipGroup(props: {
  category: string; value: string | string[] | null; multiple?: boolean;
  onChange: (v: string | string[] | null) => void;
  allowCustom?: boolean /* default true */; manageable?: boolean /* default true */; compact?: boolean;
  ariaLabel?: string;
}): JSX.Element
// SourceBadge.tsx — badge showing Auto / Manual / Reference (+confidence %)
export function SourceBadge(props: { source: ValueSource; confidence?: number | null }): JSX.Element
// FieldControl.tsx — renders a single FieldDef bound to project.manual.values[field.key];
//   shows resolved value placeholder from resolveField (auto/reference shown as hint), SourceBadge, and a
//   small "clear override" button when a manual value exists.
export function FieldControl(props: { field: FieldDef; refCategory?: string }): JSX.Element
// SectionFields.tsx — renders all fields of SECTIONS[sectionId] (from src/data/sections.ts) honoring field.mode vs project.renderMode
export function SectionFields(props: { sectionId: SectionId; fieldKeys?: string[] /* subset */ }): JSX.Element
// Slider.tsx
export function Slider(props: { value: number; min?: number; max?: number; step?: number; unit?: string; onChange: (v: number) => void; label?: string }): JSX.Element
// ColorInput.tsx — HEX input + native picker + preset swatches
export function ColorInput(props: { value: string; onChange: (hex: string) => void; label?: string }): JSX.Element
// PaletteInput.tsx — list of HEX colors with add/remove + preset palettes
export function PaletteInput(props: { value: string[]; onChange: (v: string[]) => void }): JSX.Element
// LockStateControl.tsx — segmented control for LockType: Locked / Editable / Enhance Only / Remove / Replace
export function LockStateControl(props: { value: LockType; onChange: (v: LockType) => void; compact?: boolean; allowed?: LockType[] }): JSX.Element
// PlacementEditor.tsx — position chips (category 'position': foreground/midground/background/left/right/center/front-boundary/custom),
//   custom position text, rotation slider (-180..180), scale slider (0.1..3), distance text
export function PlacementEditor(props: { value: Placement; onChange: (p: Placement) => void }): JSX.Element
// Modal.tsx
export function Modal(props: { open: boolean; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }): JSX.Element | null
// ConfirmDialog.tsx — promise-based:   const ok = await confirmDialog({ title, message, confirmLabel?, danger? })
export function confirmDialog(opts: { title: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean>
export function ConfirmHost(): JSX.Element   // mounted once in App
// ContextMenu.tsx
export interface MenuItem { id: string; label: string; icon?: IconName; danger?: boolean; disabled?: boolean; onSelect: () => void }
export function ContextMenu(props: { items: MenuItem[]; x: number; y: number; onClose: () => void }): JSX.Element  // portal, clamps to viewport, Esc/click-out closes, arrow-key nav
export function useContextMenu(): { open: (e: { clientX: number; clientY: number }, items: MenuItem[]) => void; element: JSX.Element | null }
// EntityCard.tsx — collapsible card for list entities with header actions (duplicate, delete, move up/down, drag handle)
export function EntityCard(props: { title: string; subtitle?: string; badges?: React.ReactNode; onDuplicate?: () => void; onDelete?: () => void; onMoveUp?: () => void; onMoveDown?: () => void; defaultOpen?: boolean; children: React.ReactNode }): JSX.Element
// SectionHeader.tsx — title/description/actions row used at top of each section
export function SectionHeader(props: { title: string; description?: string; actions?: React.ReactNode; step?: number }): JSX.Element
// ImageDropzone.tsx — drag&drop / click / paste upload; validates type (jpg,jpeg,png,webp) and size (ui.maxImageMB); multiple optional
export function ImageDropzone(props: { onFiles: (files: File[]) => void; multiple?: boolean; label?: string; compact?: boolean }): JSX.Element
// ImagePreview.tsx — shows a stored image by IndexedDB key with display-only rotation/flip
export function ImagePreview(props: { imageKey: string; rotation?: number; flipH?: boolean; alt: string; className?: string }): JSX.Element
// EmptyState.tsx
export function EmptyState(props: { icon: IconName; title: string; description?: string; action?: React.ReactNode }): JSX.Element
```
Import paths: `import { ChipGroup } from '../components/common/ChipGroup'` etc. (one component per file, named exports). Also `src/components/common/index.ts` re-exports all.

## Data contracts (owned by module `data`, path `src/data/`)
```ts
// src/data/options/*.ts  — each file: export const options: Record<string, OptionSeed[]>
//   OptionSeed = [id, labelEn, labelTh, value?, group?, valueTh?]   (ids globally unique, kebab-case, prefixed by category)
// src/data/sections.ts
export const SECTIONS: Record<SectionId, SectionDef>   // every SectionId has an entry (title/icon/description); declarative ones have fields
export const FIELD_REF_CATEGORY: Record<string, string> // field key -> reference category id (for resolveField)
export function getField(key: string): FieldDef | undefined
// src/data/lockElements.ts
export const LOCK_ELEMENTS: LockElementDef[]           // all elements from SPEC §4 grouped camera/architecture/material/environment
// src/data/referenceCategories.ts
export const REFERENCE_CATEGORIES: { id: string; label: Bilingual; affects: PromptGroupId; lockElements: string[] /* lock ids it could modify */ }[]
// src/data/negativeLibrary.ts
export const NEGATIVE_LIBRARY: NegativeCategory[]
// src/data/positions.ts  — option category 'position' lives in options; plus
export const POSITION_PHRASES: Record<string, Bilingual>
```
Required option categories (ids): `render-mode` not needed; `arch-style`, `facade-pattern`, `roof-type`, `arch-detail`, `material` (groups Concrete/Stone/Wood/Metal/Glass/Other), `material-finish`, `color-preset`, `camera-body`, `lens`, `focal-length`, `aperture`, `shutter`, `iso`, `white-balance`, `sensor-format`, `camera-height`, `camera-angle`, `perspective-correction`, `lighting-preset`, `sun-direction`, `sky`, `weather`, `atmosphere`, `effect`, `motion-preset`, `color-grading`, `render-engine-style`, `landscape-style`, `vegetation-type`, `plant-species`, `hardscape`, `position`, `foreground-object`, `vehicle-brand`, `vehicle-body`, `paint-finish`, `wheel-design`, `vehicle-motion`, `pose`, `clothing-style`, `activity`, `animal`, `output-aspect`, `output-quality`, `time-of-day`.

## Field keys
Auto analysis keys (see `AUTO_FIELD_KEYS`): `camera.position camera.height camera.angle camera.direction camera.focalLength camera.perspective camera.horizon camera.vanishingPoints camera.aspectRatio camera.composition arch.style arch.geometry arch.massing arch.roof arch.floorCount arch.structure arch.openings arch.facade arch.materials arch.colors arch.details env.road env.sidewalk env.terrain env.landscape env.hardscape env.sky env.lighting env.sunDirection env.shadows env.weather env.timeOfDay`.
Declarative fields describing the same property MUST reuse these keys. Additional keys: `camera.body camera.lens camera.aperture camera.shutter camera.iso camera.whiteBalance camera.exposureComp camera.dynamicRange camera.lensDistortion camera.perspectiveCorrection camera.tiltShift camera.dof camera.focusDistance camera.sensorFormat light.preset light.sunElevation light.sunIntensity light.colorTemp light.skyIllumination light.directIndirect light.gi light.ao light.shadowSoftness light.shadowLength light.reflection light.interior light.exterior light.artificialTemp fx.effects fx.lensFlare fx.bloom fx.vignette fx.haze fx.volumetric fx.chromatic fx.grain fx.highlightRolloff fx.colorGrading motion.preset motion.intensity motion.direction motion.speed motion.amount motion.blurVehicles motion.blurPeople motion.blurFoliage motion.blurBackground style.renderStyle style.photoStyle style.atmosphere arch.colorPalette land.style land.notes hard.items hard.notes output.aspect output.quality output.resolution`.

## Services
- `imageAnalysisService` (module `analysis`): `analyzeSource(file|blob, meta)`, `analyzeReference(blob, categories)`, `flattenAnalysis(result): Record<string, AutoValue>`, `checkBackend(): Promise<{ok, configured, provider, model}>`.
- `promptAssemblyService` (module `prompt-engine`): `assemblePrompt(project, options: OptionOverrides, settings?: Partial<PromptSettings>): PromptOutput` — pure, deterministic, unit-tested.
- `promptValidationService` (module `prompt-engine`): `validateProject(project, ov): ValidationIssue[]` — pure, unit-tested.
- `translationService` (module `prompt-engine`): architectural term phrasing helpers TH/EN.
- `historyService`, `presetService` (module `prompt-ui`).
- `storageService`, `optionService` (done).

## Module ownership (files you may create/edit)
| Module | Files |
|---|---|
| common-ui | `src/components/common/**`, `src/i18n/strings/common.ts` |
| data | `src/data/**` |
| prompt-engine | `src/services/promptAssemblyService.ts`, `src/services/promptValidationService.ts`, `src/services/translationService.ts`, `src/services/__tests__/**` |
| analysis | `server/**`, `src/services/imageAnalysisService.ts`, `src/sections/ModeSection.tsx`, `SourceSection.tsx`, `AnalysisSection.tsx`, `ReferencesSection.tsx` (+ their .module.css), `src/i18n/strings/analysis.ts`, `.env.example`, `tsconfig.server.json` |
| entities | `src/sections/LocksSection.tsx`, `MaterialsSection.tsx`, `LandscapeSection.tsx`, `HardscapeSection.tsx`, `ForegroundSection.tsx`, `VehiclesSection.tsx`, `PeopleSection.tsx` (+ .module.css), `src/i18n/strings/entities.ts` |
| shell | `src/App.tsx`, `src/components/layout/**` (TopBar, Sidebar, Workspace, SettingsModal, Toast), `src/hooks/**`, `src/i18n/strings/shell.ts` |
| prompt-ui | `src/components/prompt/**` (PromptPanel), `src/pages/**` (HistoryPage, PresetsPage), `src/sections/ValidationSection.tsx`, `src/sections/OutputSection.tsx`, `src/services/historyService.ts`, `src/services/presetService.ts`, `src/i18n/strings/prompt.ts` |
