# AI-generated character art workflow

The atlas pipeline checks three sources for each character sprite, in this
priority order:

1. **AI-generated images** in `src/assets/ai_characters/` (this doc) — highest priority
2. **LPC spritesheets** in `src/assets/lpc_characters/` (see `LPC_CHARACTERS.md`)
3. **Procedural Pillow rendering** in `draw_character_v3` — final fallback

If you drop a chef PNG into `ai_characters/`, it's used for the chef across the
entire game. If you don't, the loader falls through to the next source. You can
mix freely: AI chef, LPC waiter, procedural guests, all at once.

## File naming — most specific wins

For a given (role, action, facing, variant) the loader checks these paths in order:

```text
src/assets/ai_characters/{role}-v{variant}-{facing}.png    most specific
src/assets/ai_characters/{role}-v{variant}.png             variant default
src/assets/ai_characters/{role}-{facing}.png               role + facing
src/assets/ai_characters/{role}.png                        role default
```

So the **minimum viable** content is a single `chef.png` — that one file gets
used for every chef variant, every facing, every action.

The **fullest** content is 4 facings × 10 variants per role = 40 files per role
(e.g. `chef-v3-left.png`). You don't need to go anywhere near that; start with
one file per role and add specificity if you care.

## Format expectations

- **PNG with transparent background.** ChatGPT image generation can do this if
  you ask for "transparent background" explicitly.
- **Any pixel dimensions.** The loader trims transparent margins, then resizes
  preserving aspect ratio to fit the canvas (115×163 logical pixels), anchored
  at the bottom with a contact shadow below the feet.
- **Single character per file, standing pose, facing the viewer.** If the
  generator gives you a 4-facing turnaround sheet in one image, the loader will
  still take it (scaled to fit width) but the result will be cramped — better
  to split the sheet into 4 files and name them `{role}-down.png`,
  `{role}-up.png`, etc.

## Action animation gap

AI image generation **cannot** keep a character consistent across separate
generations. The same chef prompted twice will subtly drift (different face,
different hat shape, different proportions). For this reason the loader uses
**one image per file for all actions** — when a chef needs to walk or cook or
sit, we use the same standing illustration. Action props (plates for carry/
serve/clean) are composited on top in code.

If you really want different walk-1/walk-2 frames, you'd need to generate them
all in a single image (a 3-frame walk strip) and we'd add a more elaborate
loader. Not worth it for v1.

## Suggested prompts for ChatGPT image generation

Use these as starting points. Adjust the style descriptors to taste.

### chef

```
A cozy bistro chef character, full body, standing facing the camera,
in a clean cozy hand-painted illustration style matching Stardew Valley
or Spiritfarer. White double-breasted chef jacket, white chef toque hat,
small blue neckerchief at the throat, dark blue pants, brown shoes.
Friendly warm expression. Transparent background. Solid silhouette.
Roughly 64 pixels wide by 96 pixels tall.
```

### waiter

```
A cozy bistro waiter character, full body, standing facing the camera,
in a clean cozy hand-painted illustration style. Dark navy vest, crisp
white collared shirt, small red bow tie, dark trousers, polished black
shoes, small white waist apron tied at the waist. Friendly attentive
expression. Transparent background. Solid silhouette. Roughly 64x96 pixels.
```

### errand helper

```
A cozy bistro errand helper character, full body, standing facing the
camera, in a clean cozy hand-painted illustration style. Olive green
work shirt, beige half-apron with pocket tied at the waist, brown work
pants, brown leather flat cap, brown boots. Practical busy expression.
Transparent background. Solid silhouette. Roughly 64x96 pixels.
```

### guest

```
A cozy bistro customer character, full body, standing facing the camera,
in a clean cozy hand-painted illustration style. Casual modern clothing:
warm red sweater over collared shirt, dark jeans, sneakers. Pleasant
expression. Transparent background. Solid silhouette. Roughly 64x96 pixels.
```

## Saving the files

After generating, save the PNG into the right folder:

| Save as | Used for |
|---|---|
| `src/assets/ai_characters/chef.png` | All chefs (every variant, every facing, every action) |
| `src/assets/ai_characters/waiter.png` | All waiters |
| `src/assets/ai_characters/errand.png` | All errand helpers |
| `src/assets/ai_characters/guest.png` | All guests |

For variety, add specific variants:

| Save as | Used for |
|---|---|
| `src/assets/ai_characters/guest-v0.png` | Guest variant 0 |
| `src/assets/ai_characters/guest-v1.png` | Guest variant 1 (a different person) |
| `src/assets/ai_characters/guest-v2.png` | Guest variant 2 |
| `…etc up to v9` | |

For directional differences:

| Save as | Used for |
|---|---|
| `src/assets/ai_characters/chef-down.png` | Chef facing the camera |
| `src/assets/ai_characters/chef-up.png` | Chef from behind (back of head visible) |
| `src/assets/ai_characters/chef-left.png` | Chef in left profile |
| `src/assets/ai_characters/chef-right.png` | Chef in right profile |

## Test workflow

The minimum to see this work is **one file**: `src/assets/ai_characters/chef.png`.

1. Open ChatGPT (or your AI tool of choice).
2. Paste the chef prompt above, ask for a PNG with transparent background.
3. Save the result as `src/assets/ai_characters/chef.png`.
4. Run `python scripts/generate_atlases.py`.
5. Reload the game. Every chef in the kitchen is now the AI image.

If you don't like it, delete the file and the procedural chef comes back.

## Honest expectations

- **Quality**: high for a single static illustration. ChatGPT will produce nicer
  art than the Pillow polygon renderer.
- **Consistency**: low across separate generations. Each chef variant generated
  separately will look like a different person. That's the medium's limit.
- **Animation**: none. The character will stand still in every pose. Walk
  animations won't have leg motion; cook frames won't have arm movement. Props
  (plates etc.) are composited on top.
- **Pixel-art purity**: the AI image will be a smooth illustration, not crisp
  pixel art. It will look distinct from the Pillow furniture sprites — which
  may or may not be a problem visually.

If after seeing the result you don't like the visual mismatch with the
Pillow-rendered furniture, the right move is probably a paid pixel-art
character pack (e.g. LimeZu Modern Interiors $30) or staying with Pillow v1.
