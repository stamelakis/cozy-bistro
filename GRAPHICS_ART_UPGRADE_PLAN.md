# Graphics Art Upgrade Plan

## 1. Current Asset System

The game already has a real asset pipeline, but it is still mostly procedural and inconsistent in visual ambition.

- `scripts/generate_atlases.py` generates PNG atlases with Pillow:
  - `src/assets/atlases/furniture.png`
  - `src/assets/atlases/furniture.json`
  - `src/assets/atlases/characters.png`
  - `src/assets/atlases/characters.json`
  - `src/assets/atlases/environment.png`
  - `src/assets/atlases/environment.json`
  - `src/assets/atlases/ui-icons.png`
  - `src/assets/atlases/ui-icons.json`
- `src/data/visualAssets.ts` maps furniture and character definitions to atlas frame names, scale, origins, and metadata lookup.
- `src/scenes/GameScene.ts` loads the atlases in `preload()` and renders:
  - most furniture as atlas images when a frame exists,
  - floor/wall finishes and some wall decorations with Phaser `Graphics`,
  - table plates, dirty dishes, selection outlines, placement previews, and bubbles with Phaser `Graphics`/`Text`,
  - characters from `characters.png`, with older procedural graphics fallback still present.
- `src/data/furniture.ts` defines furniture ids, categories, size, cost, tier, color, comfort/style values, cooking slots, and seating capacity.
- `src/data/recipes.ts` defines recipes and drives food/serving state.
- UI panels and world bubbles are mostly Phaser `Text` and `Graphics`, not image assets.

Current visual content source:

- Characters: generated PNG atlas frames from `draw_character_v3()` in `scripts/generate_atlases.py`.
- Furniture: generated PNG atlas frames from category functions in `scripts/generate_atlases.py`, especially `draw_table_sprite`, `draw_chair_sprite`, `draw_bench_sprite`, `draw_stove_sprite`, `draw_counter_sprite`, and `draw_decor_sprite`.
- Floor tiles: some generated atlas frames for placed flooring, plus procedural Phaser floor rendering and grid lines.
- Walls/wallpaper/windows/doors/menu boards: mostly Phaser `Graphics` inside `GameScene.ts`, with a small environment atlas for wall/door/sign primitives.
- UI/world icons: a tiny `ui-icons` atlas exists, but many world bubbles still use text/emoji-like glyphs.

## 2. Why The Current Visuals Look Primitive

The game looks primitive because the asset system exists, but the art direction is not yet strong enough:

- Many sprites are built from simple ellipses, rounded rectangles, and thick outlines.
- Character faces still read as dots/lines, with simplified hair and limited expression.
- Furniture silhouettes are still blocky, especially counters, basic tables, and chairs.
- Some objects use different detail density and outline weights.
- Some UI/world icons still use emoji-like text glyphs instead of original game icons.
- The floor/grid competes visually with the art instead of quietly supporting it.
- Lighting is present but inconsistent: top/side shading, contact shadows, and highlights vary by asset.
- The palette is split across TypeScript and Python constants rather than one documented style system.
- Generated art lacks the hand-authored detail density of the target references: bevels, trim, small props, shiny surfaces, textiles, and identifiable food.

## 3. Biggest Visual Problems

Priority problems:

1. Characters
   - Need more intentionally designed proportions, faces, hair, uniforms, and seated poses.
   - Current style still looks assembled from primitive shapes.

2. Tables and chairs
   - They expose art quality immediately because they repeat everywhere.
   - They need cleaner silhouettes, better leg design, stronger materials, better tablecloths, and more natural plate placement.

3. World bubbles/icons
   - Emoji-like glyphs break the custom art style and dominate the scene.

4. Counters/stoves/sinks/dishwashers
   - These should read as detailed restaurant equipment, not generic boxes.

5. Plants and decor
   - Plants need richer leaf clusters and less repeated geometry.
   - Decor should create the emotional reward of upgrading.

6. Floor/walls
   - Floor needs richer material variation and less debug-grid feeling.
   - Walls need coherent paint/wallpaper coverage, trim, and decoration surfaces.

## 4. Recommended Solution

Use a hybrid asset approach:

- Primary approach: improve the existing Pillow atlas generator.
  - This preserves the current Phaser rendering pipeline and save compatibility.
  - It gives us repeatable original assets without relying on copyrighted art.
  - It allows all existing furniture ids to keep working.
- Secondary approach: keep Phaser `Graphics` for dynamic overlays only.
  - Placement previews
  - Selection outlines
  - Temporary feedback bubbles
  - Plates/dirty dishes where they depend on live state
  - Wall finish panels that need to stretch across variable wall sizes
- Later optional approach: replace the generated PNGs with hand-authored PNG/SVG art while keeping the same atlas manifest and frame names.

This pass should not replace the game engine, grid, save format, pathfinding, economy, or simulation. The art pipeline should become stronger without destabilizing gameplay.

## 5. Exact Files To Modify

Main files:

- `scripts/generate_atlases.py`
  - Main generated art source for furniture, characters, plants, equipment, environment, and UI icons.
- `src/data/visualAssets.ts`
  - Sprite registry, scale/origin rules, frame names, character frame mapping.
- `src/data/graphicsTheme.ts`
  - New central TypeScript palette/style file for UI and runtime graphics.
- `src/scenes/GameScene.ts`
  - Runtime rendering, dynamic overlays, bubbles, wall/floor rendering, sorting, and UI styling.
- `GRAPHICS_ART_UPGRADE_PLAN.md`
  - This plan.

Generated output files:

- `src/assets/atlases/furniture.png`
- `src/assets/atlases/furniture.json`
- `src/assets/atlases/characters.png`
- `src/assets/atlases/characters.json`
- `src/assets/atlases/environment.png`
- `src/assets/atlases/environment.json`
- `src/assets/atlases/ui-icons.png`
- `src/assets/atlases/ui-icons.json`

Reference data files:

- `src/data/furniture.ts`
- `src/data/recipes.ts`

## 6. Staged Implementation Plan

### Phase 1: Audit And Plan

- Confirm which visuals are atlas-generated versus runtime-generated.
- Document current pipeline and risks.
- Identify primitive/high-impact asset groups.

### Phase 2: Style System

- Add a central TypeScript graphics theme with warm restaurant colors, shadow/highlight colors, UI bubble colors, and role colors.
- Mirror the same palette intent in `scripts/generate_atlases.py`.
- Use muted, cozy, warm colors instead of random saturated colors.

### Phase 3: Character Art Upgrade

- Improve `draw_character_v3()` or replace it with a new generated character style.
- Improve:
  - head/body balance,
  - face construction,
  - hair silhouettes,
  - uniforms,
  - customer clothing variation,
  - seated posture,
  - carried plates/trays.
- Keep the frame naming contract unchanged.

### Phase 4: Furniture And Environment Upgrade

- Improve generated table/chair/bench art first.
- Then improve stoves, counters, sinks, dishwashers, plants, rugs, and props.
- Add consistent bevels, contact shadows, highlights, material details, and better silhouettes.
- Keep atlas frame names and metadata compatible.

### Phase 5: Icon/UI Art Upgrade

- Stop relying on emoji-like world bubble glyphs.
- Generate/use small original icon symbols or compact styled text glyphs as an interim step.
- Later migrate bubbles from `Text` to a small icon container using `ui-icons.png`.

### Phase 6: Lighting, Shadows, Effects

- Standardize one light direction.
- Add consistent neutral contact shadows.
- Add subtle highlights on plates, counters, appliances, and glass.
- Avoid heavy black shadows or colored fake shadows.

### Phase 7: Animation And QA

- Improve character animation states after the new art reads correctly.
- Verify:
  - build/move/sell/rotate,
  - seating,
  - cooking,
  - serving,
  - payment,
  - save/load,
  - camera rotation.
- Run `npx.cmd tsc --noEmit`.

## 7. Limitations Without External Hand-Authored Art

The current pipeline can produce a much better original look, but it is still procedural art. It will not fully match the polish of professionally hand-authored commercial sprites without:

- dedicated sprite painting,
- more animation frames,
- dedicated character turnarounds,
- bespoke furniture silhouettes per item,
- high-resolution source art,
- art direction review against a style guide.

The best near-term path is to upgrade the generated atlas style substantially, then gradually replace the most visible generated frames with hand-authored sprites while preserving the existing atlas names and metadata.

## First Implementation Slice

This pass should deliver:

- central runtime graphics palette,
- cleaner bubble styling,
- less emoji-like world status symbols,
- warmer and more consistent generated palettes,
- improved generated character/furniture/detail rendering,
- regenerated atlases,
- TypeScript validation.

This is not the final visual state. It is the foundation for real asset-quality improvement without throwing away the game systems.
