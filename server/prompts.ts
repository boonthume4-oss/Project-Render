// System prompts and JSON schemas used for vision analysis.
// The schemas are sent as structured-output formats so the model returns parseable JSON;
// server/normalize.ts still validates everything before it reaches the client.

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const strList = { type: 'array', items: str } as const;

function obj(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export const SOURCE_SCHEMA = obj({
  summary: str,
  camera: obj({
    position: str,
    height: str,
    angle: str,
    direction: str,
    focal_length_estimate: str,
    perspective: str,
    horizon: str,
    vanishing_points: str,
    aspect_ratio: str,
    composition: str,
    confidence: num,
  }),
  architecture: obj({
    style: str,
    geometry: str,
    massing: str,
    roof: str,
    floor_count: str,
    structure: str,
    openings: str,
    facade: str,
    materials: strList,
    colors: strList,
    details: strList,
    confidence: num,
  }),
  environment: obj({
    road: str,
    sidewalk: str,
    terrain: str,
    landscape: strList,
    hardscape: strList,
    sky: str,
    lighting: str,
    sun_direction: str,
    shadows: str,
    weather: str,
    time_of_day: str,
    confidence: num,
  }),
  objects: {
    type: 'array',
    items: obj({
      type: { type: 'string', enum: ['vehicle', 'person', 'animal', 'tree', 'furniture', 'other'] },
      description: str,
      position: str,
      orientation: str,
      scale: str,
      confidence: num,
    }),
  },
  uncertainties: strList,
});

/**
 * Thai mirror of SOURCE_SCHEMA's text, produced by a second, text-only call (TRANSLATE_SYSTEM).
 * It cannot live inside SOURCE_SCHEMA: the combined schema exceeds the structured-output grammar
 * limit ("The compiled grammar is too large").
 */
export const SOURCE_TH_SCHEMA = obj({
    summary: str,
    camera: obj({
      position: str,
      height: str,
      angle: str,
      direction: str,
      focal_length_estimate: str,
      perspective: str,
      horizon: str,
      vanishing_points: str,
      aspect_ratio: str,
      composition: str,
    }),
    architecture: obj({
      style: str,
      geometry: str,
      massing: str,
      roof: str,
      floor_count: str,
      structure: str,
      openings: str,
      facade: str,
      materials: strList,
      colors: strList,
      details: strList,
    }),
    environment: obj({
      road: str,
      sidewalk: str,
      terrain: str,
      landscape: strList,
      hardscape: strList,
      sky: str,
      lighting: str,
      sun_direction: str,
      shadows: str,
      weather: str,
      time_of_day: str,
    }),
    objects: {
      type: 'array',
      items: obj({ description: str, position: str, orientation: str, scale: str }),
    },
    uncertainties: strList,
});

export function referenceSchema(categories: string[]) {
  return obj({
    summary: str,
    categories: {
      type: 'array',
      items: obj({
        category: { type: 'string', enum: categories },
        description: str,
        description_th: str,
        confidence: num,
      }),
    },
    uncertainties: strList,
    summary_th: str,
    uncertainties_th: strList,
  });
}

const HONESTY_RULES = `Honesty rules (mandatory):
- Describe ONLY what is actually visible in the image. Never invent facts that cannot be seen (hidden facades, interior layout, exact brands, exact dimensions, materials you cannot distinguish).
- For every text field use exactly one of these forms:
  * A plain description when it is clearly visible.
  * "Estimate: <value>" when you infer it from visual cues but cannot be sure (e.g. focal length, camera height, time of day).
  * "Needs confirmation: <value>" when the image is ambiguous and a human should verify it.
  * "Unknown" when it cannot be determined from the image at all.
- For list fields, use [] when nothing is visible; list items may use the same prefixes.
- Confidence values are numbers from 0 to 1 describing how reliable that whole section is.
- Every guess you had to make must also be listed in "uncertainties" as a short sentence.
- Write in English, concise professional architectural-photography terminology.`;

const THAI_RULES = `Thai translation (mandatory, in the same response):
- After the English fields, provide a Thai version of the SAME text so Thai prompts can be written entirely in Thai.
- The Thai must say exactly the same thing as the English — same facts, same hedging, same level of detail. Never add, drop or "improve" facts in Thai.
- Use natural, professional Thai architectural and photographic terminology as a Thai architect would write it (not a word-for-word translation).
- Keep proper nouns, brand and model names, HEX codes (#RRGGBB), numbers and units (mm, m, K, °, %) in Latin script exactly as in the English.
- Express certainty in Thai with these forms instead of the English prefixes: "ประมาณการ: <ค่า>" for Estimate, "ต้องยืนยัน: <ค่า>" for Needs confirmation, and "ไม่ทราบ" for Unknown. Do not use the English words Estimate / Needs confirmation / Unknown in Thai text.
- Lists in Thai must have exactly the same number of items, in the same order, as the English lists (a Thai list with a different count is discarded).
- When an English value is "Unknown — <hint>", write "ไม่ทราบ: <hint>" with the colon; write a plain "ไม่ทราบ" only when the English is just "Unknown".`;

export const SOURCE_SYSTEM = `You are an expert architectural photographer and architect analysing a SOURCE image that will be preserved during AI re-rendering. Your structured analysis is used to write prompts that keep the building, road, camera angle and existing objects exactly where they are, so precision and honesty matter more than completeness.

What to extract:
- camera: position (e.g. "street level, across the road, facing the main facade"), height (eye level / elevated / aerial, with an estimated metre value only as an Estimate), angle (frontal, two-point / three-point corner view, tilt up/down), direction the camera faces, focal_length_estimate (35mm-equivalent, always an Estimate unless EXIF-like evidence is visible), perspective (one/two/three-point, converging verticals or corrected), horizon (position in frame, level or tilted), vanishing_points, aspect_ratio of the frame, composition (framing, where the building sits, foreground/background layering).
- architecture: style, geometry, massing, roof form, floor_count, structural system as visible (columns, beams, cantilevers), openings (doors/windows rhythm), facade pattern, materials (list, one material per item, with location e.g. "board-formed concrete on ground-floor wall"), colors (list; include approximate HEX only as "Estimate: #xxxxxx"), notable details (list).
- environment: road (geometry, alignment, surface, lanes, markings), sidewalk and curbs, terrain, landscape (list of visible planting), hardscape (list), sky, lighting, sun_direction (relative to the camera, e.g. "from upper left, behind camera"), shadows, weather, time_of_day.
- objects: every vehicle, person, animal and tree that is visible, each with position in the frame (e.g. "left foreground, parked parallel to the curb"), orientation/heading relative to the camera, apparent scale relative to the building, and a confidence. Do not identify car brands/models unless clearly legible; otherwise describe body type and colour.
- summary: two or three sentences describing the scene.

${HONESTY_RULES}`;

/** Second call for source analysis: translate the English JSON (no image) into SOURCE_TH_SCHEMA. */
export const TRANSLATE_SYSTEM = `You translate a structured English architectural image analysis into Thai for Thai image-generation prompts. You do not see the image; translate only what the English says.

Return the Thai version of every text field (summary, camera, architecture, environment, uncertainties) and "objects" with the Thai description / position / orientation / scale of each object in the SAME order as the English "objects" array (one entry per object). Ignore confidence numbers and object types.

${THAI_RULES.replace('(mandatory, in the same response)', '(mandatory)').replace('After the English fields, provide a Thai version of the SAME text', 'Provide a Thai version of the SAME text')}`;

export function translateUserText(englishJson: unknown): string {
  return `Translate this English analysis into Thai following the rules:\n\n${JSON.stringify(englishJson)}`;
}

export function referenceSystem(categories: string[]): string {
  return `You are an expert architect and architectural photographer analysing a REFERENCE image. The user will borrow ONLY specific aspects of this reference for a different project, so describe each requested category in a way that can be transferred as text into an image-generation prompt.

Requested categories (describe ONLY these, one entry per category, in this order): ${categories
    .map((c) => `"${c}" (${c.replace(/[-_]/g, ' ')})`)
    .join(', ')}.

For each category write a concise, specific description of what the reference shows for that aspect (materials with finish and colour, lighting direction and quality, planting species types and arrangement, colour palette with approximate HEX as Estimates, lens/compositional character, etc.). If the category is not visible or not applicable in this image, write "Unknown" for it and give it confidence 0. Do not describe anything outside the requested categories in the category entries.

For every category also write "description_th": the Thai version of that description ("ไม่ทราบ" when the English is "Unknown"). Also give "summary_th" (Thai version of the summary) and "uncertainties_th" (Thai version of each uncertainty, same order).

${HONESTY_RULES}

${THAI_RULES}`;
}

export const SOURCE_USER_TEXT =
  'Analyse this source image and return the structured analysis. Remember: visible facts only; use Unknown / Estimate: / Needs confirmation: where appropriate.';

export const REFERENCE_USER_TEXT =
  'Analyse this reference image for the requested categories only and return the structured result with the Thai versions (description_th, summary_th, uncertainties_th). Visible facts only.';
