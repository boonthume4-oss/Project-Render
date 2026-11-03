# SPEC — AI Architectural Rendering Prompt Studio (condensed from the user's Thai master prompt; every requirement retained)

Production web app (not a mockup) that analyzes architectural source photos + reference images and produces structured, detailed professional prompts (TH + EN) for AI image generation / rendering, minimizing generation errors. Emphasis: preserve the source image — building, road, camera angle, car positions.

## 1. Core objectives
1 analyze source image → structured data · 2 analyze each reference separately per element · 3 lock/edit each element independently · 4 comprehensive preset options (minimal typing) · 5 TH + EN prompts · 6 modes: Photorealistic Architectural Photography / Ultra-Realistic Architectural Rendering · 7 merge Auto Analysis + Manual config without overlap/loss · 8 real-time Prompt Preview with Copy, Clear, Reset, Edit · 9 history & reuse · 10 add/delete/edit/reorder/save user options · 11 preserve building, road, camera, vehicle positions · 12 conflict checking before prompt. Never drop features; split into clear modules.

## 2. Design — Apple macOS / iOS-inspired (not claiming to be Apple)
White / off-white / light gray / graphite / black; restrained accent (graphite or System Blue) only where needed; **NO purple**. SF Pro when available, system-ui fallback. Minimal line icons, light gray by default. Translucent surfaces + backdrop blur in moderation; rounded corners, soft shadows, thin dividers, good whitespace. No oversized buttons. Main options = flat horizontal chips. Hierarchy via size/weight/color/spacing. Light + Dark. Responsive desktop/tablet/mobile.

Layout (4 areas):
A. Top Nav: logo + name, TH/EN toggle, Light/Dark toggle, Undo/Redo, Settings, save status.
B. Left Sidebar: all config categories; collapse/expand each; clear active highlight; selecting one keeps it open and collapses others (per setting); Pin to keep sidebar shown; drag to reorder categories; internal scroll not affecting page.
C. Main Workspace: source image area, reference area, analysis area, element settings, Lock/Editable status per element.
D. Floating Prompt Panel on the right; must NOT overlap top nav, sidebar or workspace (reserve space with Grid/Flex); Pin to always show; when unpinned hides on click-outside or minimize button; visible reopen button; draggable when appropriate but never off-screen; on mobile becomes Drawer / Bottom Sheet.
Every click/collapse/expand/pin/select must really work. No dead buttons.

## 3. Workflow
STEP1 choose mode (Photo / Render). STEP2 upload source (JPG JPEG PNG WEBP), preview, rotate/adjust display without altering original, change/delete/re-analyze. STEP3 analyze source: architecture elements, perspective & camera position, structure, materials, colors, light, shadow, road, landscape; split into editable fields; show confidence when available; user confirms uncertain data. STEP4 references: multiple, each numbered + named, choose elements to reference per image, analyze each separately, weight per reference, add/delete/replace/re-analyze/reorder. STEP5 details: Auto Analysis as default, user can edit or enter manually, show source of each value (Auto / Manual / Reference), Manual Override beats Auto. STEP6 validation: Lock vs Reference conflicts; material/color/light/environment conflicts; warn when conditions may distort the image; user decides keep or fix. STEP7 generate: from all data, choose TH/EN, choose detail level, copy, clear or reset per part, history & save preset.

## 4. Source image — per-element Lock System (not one boolean)
Camera & Composition: Camera Position, Camera Height, Camera Angle, Camera Direction, Focal Length/FOV, Perspective, Horizon Line, Vanishing Points, Crop, Aspect Ratio, Image Framing, Composition.
Architecture: Building Geometry, Building Massing, Roof Shape, Roof Height, Floor Count, Structural System, Columns and Beams, Openings, Doors and Windows, Facade Pattern, Balcony and Terrace, Stairs and Ramps, Boundary Walls, Building Proportions, Existing Architectural Details.
Material & Color: Primary Material, Secondary Material, Surface Color, Texture Pattern, Reflectivity, Roughness, Transparency, Material Scale, Joint Pattern, Weathering.
Environment: Existing Road Geometry, Road Boundaries, Sidewalks, Curbs, Driveway, Terrain, Existing Landscape, Sky, Clouds, Vegetation, Shadows, Sun Direction, Existing Vehicles, Existing People, Pets, Background Buildings.
Sub-locks: Position Lock, Rotation Lock, Scale Lock, Appearance Lock for supported objects.
States: Locked (no change of form & position) · Editable (may change per reference) · Enhance Only (improve realism, keep shape/color/position) · Remove (explicit user removal) · Replace (replace with new element per conditions).
Locked/Enhance Only → prompt must explicitly instruct preservation of shape, position, proportion, details. Never claim prompts guarantee 100% pixel/geometry preservation if the engine doesn't support it (show a note).

## 5. Reference image intelligence
Per-reference settings panel. Usage categories: Architectural Style, Building Form, Facade Design, Roof Design, Window and Door Design, Material, Color Palette, Lighting, Shadow, Sky, Landscape, Hardscape, Road Design, Foreground, Background, Furniture, Decorative Objects, Vehicle, Human Figures, Animals, Camera Style, Lens Character, Composition, Depth of Field, Color Grading, Photographic Style, Rendering Style, Weather, Atmosphere, Other — plus None, Custom, Select All.
Per category details: what to use, what NOT to use, priority, Reference Weight, where to apply, relationship to source.
Example: Ref1 only Material+Color Palette+Lighting; Ref2 only Landscape+Hardscape; Ref3 only Camera Style+Color Grading. Never apply Ref1's building form over the source building unless allowed.
Critical: references are analyzed and converted to text + structured data BEFORE prompt building. Text-Only Prompt mode: do NOT attach source or reference files to generation; send only the prompt. Image Analysis is separate from Image Generation. Image-to-Image / Mask / Depth / ControlNet is a separate mode the user enables explicitly.

## 6. Auto image analysis
Separate tool from normal form: Upload Image, Analyze Image, Analysis Status, Extracted Data, Confidence Level, Apply to Form, Re-analyze, Clear Analysis. Output = structured data (camera{position,height,angle,focal_length_estimate,perspective,confidence}, architecture{style,geometry,materials[],colors[],confidence}, environment{road,landscape[],sky,lighting,confidence}, objects[], uncertainties[]), extensible. Never invent invisible facts — show Unknown / Estimate / Needs Confirmation. Auto data separate from manual input so each can be cleared/edited independently.

## 7. Architectural style selector
Each main topic: comprehensive presets + Add Custom Option. Styles: Contemporary, Modern Minimalist, Tropical Modern, Tropical Contemporary, Quiet Luxury, Modern Luxury, Organic Modern, Brutalist, Minimalist Concrete, Japanese Minimalism, Scandinavian, Mediterranean, Neo-Classical, Classical, Industrial, Vernacular, Biophilic, Futuristic, Parametric Architecture, Sustainable Architecture, Custom Style — TH + EN labels for all. Also categories for facade patterns and architectural details. Searchable, grouped, not overly long lists.

## 8. Material & color library
Concrete: Smooth Fair-Faced, Board-Formed, Exposed Aggregate, Polished, Architectural Precast. Stone: Travertine, Limestone, Marble, Granite, Sandstone, Natural Rough Stone. Wood: Natural Oak, Walnut, Teak, Thermowood, Wood Slats, Engineered Wood Cladding. Metal: Anodized Aluminum, Brushed Stainless Steel, Blackened Steel, Weathering Steel, Powder-Coated Aluminum. Glass: Clear, Low-E, Neutral Reflective, Tinted, Frosted. Other: Brick, Terracotta, Ceramic Tile, Porcelain Slab, Limewash, Stucco, Microcement, Vinyl Slats, Composite Panels.
Each material: Color, Finish, Roughness, Reflectivity, Texture Scale, Joint Width, Wear Level. Color Palette, HEX input, presets, custom colors. Locked materials never change even if a reference uses another material.

## 9. Camera & photography (Photo mode)
Bodies: Phase One XF/IQ4, Hasselblad H System, Fujifilm GFX System, Canon EOS R5 Mark II, Sony Alpha 1 II, Nikon Z8. Lenses: Tilt-Shift Architectural, Wide-Angle Prime, Standard Prime, Telephoto, Medium-Format. Focal: 17 20 24 28 35 50 80mm + Custom. Settings: Aperture, Shutter Speed, ISO, White Balance, Exposure Compensation, Dynamic Range, Lens Distortion, Perspective Correction, Tilt-Shift, Depth of Field, Focus Distance, Camera Height, Sensor Format. Lighting presets: Golden Hour, Morning Light, Midday Sun, Overcast, Blue Hour, Twilight, Night Photography, Studio Lighting, Diffused Natural Light. Camera/lens are descriptions of photographic character — never claim real optical simulation.

## 10. Lighting, effects, motion (presets + custom + motion where relevant)
Lighting: Sun Direction, Sun Elevation, Sun Intensity, Color Temperature, Sky Illumination, Direct/Indirect, GI, AO, Shadow Softness, Shadow Length, Shadow Direction, Reflection Intensity, Interior Light, Exterior Light, Artificial Light Temperature.
Effects: Lens Flare, Sunburst, Bloom, Vignette, Motion Blur, DoF, Atmospheric Haze, Volumetric Light, Chromatic Aberration, Film Grain, Highlight Roll-Off, Lens Distortion, Color Grading.
Motion presets: Static, Subtle Motion, Slow Camera Pan, Camera Dolly, Tracking Shot, Slow Push-In, Slow Pull-Out, Vehicle Motion, Human Motion, Tree and Foliage Motion, Wind Motion, Moving Clouds, Rain Motion, Water Motion. Motion blur separate per object (vehicles, people, foliage, background). In still mode convert motion into still-photo motion cues only — never make it look like video. Motion Intensity, Direction, Speed, Amount.

## 11. Landscape & hardscape (separate)
Landscape styles: Tropical Garden, Minimalist Garden, Japanese Garden, Mediterranean Garden, Naturalistic Landscape, Formal Garden, Native Planting, Xeriscape, Forest Garden, Contemporary Luxury Landscape.
Vegetation types: Trees, Palms, Shrubs, Hedges, Groundcover, Ornamental Grass, Ferns, Climbers, Flowering Plants, Aquatic Plants; each: Species, Mature Height, Canopy Width, Density, Leaf Texture, Health, Planting Pattern, Position, Spacing, Growth Stage, Wind Response.
Hardscape: Existing Road, Asphalt, Concrete Paving, Natural Stone Paving, Gravel, Stepping Stones, Curbs, Sidewalks, Driveways, Retaining Walls, Water Features, Decking, Outdoor Stairs, Garden Edging.
Constraints (emit in prompt): landscape must not cover the existing road; trees never grow through buildings/structures; hardscape never blocks building entrances; never change locked road alignment/curbs; tree scale relative to building; plants touch ground naturally; tree shadows match light direction; no floating trees; roots/trunks/branches don't intersect ground or objects; don't hide key architecture. Positions: Foreground, Midground, Background, Left, Right, Front Boundary, Custom.

## 12. Foreground & composition
Objects: Ornamental Plants, Tree Branches, Decorative Stone, Water Feature, Garden Furniture, Planters, Low Walls, Natural Ground Cover, Gravel, Outdoor Sculptures, Custom. Per object: type, position, scale, rotation, distance from camera, blur, opacity, occlusion limit, reference source. Anti-occlusion of building + preserve key building lines. Foreground may get motion blur / DoF without affecting main building sharpness.

## 13. Vehicles + position lock
Controls: Brand, Model, Year, Body Style, Paint Color, Paint Finish, Wheel Design, Wheel Size, Tire Type, Window Tint, Headlight State, Taillight State, Reflection, Cleanliness, Position, Rotation, Scale, Camera-relative Distance, Motion State, Motion Blur. Brands: Mercedes-Benz, BMW, Porsche, Bentley, Rolls-Royce, Ferrari, Lamborghini, Aston Martin, Range Rover, Lexus, Audi, McLaren + free text brand/model/year/details.
When locked: keep position, heading/angle, size/proportion; don't move; no new car over the old one; don't delete; no duplicates; keep relations car–road–curb–building. With a specified model, describe model-specific body shape, lights, grille, wheels, exterior details. Never guarantee exact model match from text alone (note it).

## 14. People & animals
People: count, adult/child, appearance, clothing style & color, pose, walking/standing/sitting, activity, position, scale, distance, motion, motion blur, focus, occlusion limit; culturally contextual attire selectable.
Animals: Dog, Cat, Bird, Fish, Other; breed/species, position, scale, pose, direction, activity, distance, motion.
Occlusion rules: people don't block the main building; animals don't hide key architecture; real-world proportions; feet on ground; shadows match light; no extra limbs/deformed anatomy; nothing floats unsupported; plausible distances & contacts.

## 15. Physics & realism validation (before copy)
Check: Geometry Consistency, Camera Perspective, Scale Consistency, Ground Contact, Shadow Direction, Lighting Consistency, Reflection Consistency, Material Behavior, Vehicle-Wheel Contact, Road and Curb Alignment, Planting and Terrain Contact, Human Anatomy, Occlusion, Object Duplication, Existing Object Preservation.
Negative Prompt Library with per-category on/off: No distorted architecture, No altered building geometry, No changed camera position, No road deformation, No floating objects, No duplicated vehicles, No incorrect vehicle proportions, No intersecting vegetation, No unrealistic shadows, No physically impossible reflections, No unwanted foreground occlusion, No extra doors or windows, No inconsistent perspective. Negative prompt adapts to mode & selected conditions (not the same text for every job).

## 16. Prompt assembly engine — order
1 Global System Constraints 2 Source Image Preservation 3 Camera & Composition 4 Architectural Geometry 5 Material & Color 6 Reference Image Interpretation 7 Lighting & Atmosphere 8 Landscape & Hardscape 9 Vehicles 10 People & Animals 11 Foreground & Background 12 Photographic or Rendering Style 13 Physics & Realism 14 Effects & Motion 15 Negative Prompt 16 Output Quality. Readable grouping, no duplicates, no contradictions.
Priority: Explicit Lock > Reference; Manual > Auto; Reference only for allowed categories; Global constraints always; conflicts → Warning; user confirms or fixes.
Languages TH, EN — translate architectural meaning properly, not word-by-word. Detail levels: Compact, Professional, Detailed, Maximum Detail. Separate outputs: Main Prompt, Negative Prompt, Technical Parameters, Full Combined Prompt.
Actions: Copy, Copy Main, Copy Negative, Copy Full, Clear Prompt, Reset to Generated Version, Undo, Redo, Edit Manually, Export TXT, Save as Preset. Clear asks: only auto-generated text, only manually entered text, or all. Clearing Auto Analysis never deletes Manual Input without instruction. Copy Full includes all enabled data, restructured, nothing active lost.

## 17. Full option management
Every category: Add, Edit, Delete, Duplicate, Drag to Reorder, Search, Reset Category, Restore Default Options. Right-click custom option → Edit, Duplicate, Delete, Move Up, Move Down; touch devices get an alternative menu. Custom options persist after refresh. Built-in defaults never permanently deleted by accident — Restore Defaults.

## 18. History & presets (separate pages)
History entry: date/time, project name, source image metadata, selected references, render mode, language, prompt text, selected options, lock settings, custom overrides. Actions: Load Previous Session, Duplicate Session, Rename, Delete, Delete Multiple, Save as Preset, Reuse Configuration. Reload restores everything actually saved. Named presets e.g. Quiet Luxury Daylight, Tropical Modern Photography, Minimalist Concrete Rendering, Golden Hour Villa, Premium Automotive Exterior. History and Presets clearly separate.

## 19. Bilingual
Whole site TH/EN: labels, buttons, tooltips, dropdowns, errors, validation, context menus, options. Translation dictionary (no scattered strings). Changing UI language never loses prompt/edits/values. UI language and Prompt language chosen separately.

## 20–22. Technical
React + TS + Vite, CSS Modules, components, LocalStorage/IndexedDB persistence, backend API for real image analysis, adapter layer for AI Vision & Image Generation APIs. Vision only via a service with real image access — never guess from filenames/text. No API keys in frontend; env vars + backend proxy. Services: imageAnalysisService, promptAssemblyService, promptValidationService, historyService, presetService, translationService, storageService. Without key/backend: clear Demo Mode notice; never claim AI analysis succeeded; never show fake analysis as image data; interface ready for real API.
Data model: Project{id,name,sourceImageMetadata,referenceImages,renderMode,languageSettings,lockSettings,autoAnalysisData,manualInputData,selectedOptions,generatedPrompt,negativePrompt,createdAt,updatedAt}, ReferenceImage{id,name,metadata,allowedCategories,excludedCategories,weight,analysisData,customInstructions}, PromptOption{id,category,labelTh,labelEn,value,isDefault,isCustom,enabled,order}, LockSetting{elementId,lockType,enabled,constraints}.
Loading states, error + retry, file type/size validation, prevent duplicate Generate clicks, keyboard navigation, tooltips for unclear icons, visible focus, small screens, prompt preview never covers tools, no data loss when switching categories, unsaved-changes warning, storage quota & large image handling, user can delete history and local data.

## 23. Acceptance tests
01 upload source → shown + analyzed via real connected service · 02 3 references each with different categories · 03 lock building geometry but allowed materials change · 04 lock car position → prompt keeps position & heading · 05 landscape never instructed to cover locked road · 06 clearing Auto keeps Manual · 07 clearing Manual keeps Auto · 08 Copy Full includes all enabled categories · 09 switching UI language keeps prompt & data · 10 add/edit/delete/drag custom options work · 11 history reload works · 12 floating prompt panel doesn't cover top nav/workspace · 13 pin/unpin works desktop + mobile · 14 conflicts warn before assembly · 15 refresh keeps saved data · 16 every button/menu works.
## 24. Delivery: verify everything; list what works vs what needs API connection; never claim tests passed unless actually run.
