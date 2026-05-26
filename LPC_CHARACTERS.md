# LPC character spritesheet workflow

The game can load characters two ways:

1. **Procedural Pillow rendering** (the default fallback) — what `draw_character_v3` in
   `scripts/generate_atlases.py` does. Lower art quality but no external assets needed.
2. **LPC spritesheets** — pre-made artist-quality pixel art dropped into
   `src/assets/lpc_characters/{role}/v{N}.png`. When present, these override the
   Pillow renderer for that variant.

This doc covers path #2.

## The plan

You build characters at the **Universal LPC Spritesheet Character Generator** in your
browser, download each as a single PNG, drop them into `src/assets/lpc_characters/`,
and the atlas pipeline picks them up on the next `python scripts/generate_atlases.py`.

LPC = "Liberated Pixel Cup", a standard 832×1344 pixel-art spritesheet format. Every
LPC character has the same frame layout (rows are animations: cast/thrust/walk/slash/
shoot/hurt; columns are frames within each animation), so the loader is one function
and the same for everyone.

## Generator URL

<https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/>

## Build instructions per role

For the **first pass** you only need to build **4 characters** (1 per role) to check
the look. Once you like the result, build more variants the same way.

### Common setup for every character

1. Open the generator.
2. **Body** → pick a body type (e.g. "Male" or "Female" — both work) and a skin tone.
3. **Head/face** → pick a head shape.
4. **Eyes / nose / ears** → pick whatever.
5. **Hair** → pick a hair style + color. Vary this per variant so they don't all
   look the same.

### chef (role = "chef")

- **Clothes → Shirt**: pick the **chef shirt / coat** (white, double-breasted is best).
- **Clothes → Apron**: optional white apron if available.
- **Hats**: pick the **chef hat (toque)**.
- Skip weapons, shields, armor.

### waiter (role = "waiter")

- **Clothes → Shirt**: pick a dark **vest** or **formal shirt** (black/dark blue).
- **Clothes → Pants**: dark pants (black or dark gray).
- **Clothes → Bow tie** if available (otherwise a regular tie).
- **Clothes → Apron**: optional small waist apron in white.
- No hat.

### errand (role = "errand")

- **Clothes → Shirt**: a green or brown work shirt.
- **Clothes → Apron**: a half-apron in beige/tan.
- **Hats**: a **flat cap** or **baker's cap** if available.
- Skip formal accessories.

### guest (role = "guest")

- Casual clothing: any sweater, dress, jacket, hoodie etc.
- No apron, no hat (or a casual hat if you want personality).
- This is the role where variety matters most — make each one look distinctly
  different.

## Saving the file

Once your character looks good:

1. Scroll down on the generator page and find the **Image** preview pane.
2. Click **Save as PNG**.
3. Name the file `v0.png` (or `v1.png`, `v2.png`, … up to `v9.png` for the variant
   index).
4. Move it to the matching folder:

   ```text
   src/assets/lpc_characters/chef/v0.png
   src/assets/lpc_characters/waiter/v0.png
   src/assets/lpc_characters/errand/v0.png
   src/assets/lpc_characters/guest/v0.png
   ```

## For the 4-character test

Build just these four files:

| File path | What to build |
|---|---|
| `src/assets/lpc_characters/chef/v0.png` | Any chef character (white coat + toque) |
| `src/assets/lpc_characters/waiter/v0.png` | Any waiter (dark vest + bow tie) |
| `src/assets/lpc_characters/errand/v0.png` | Any errand helper (apron + cap) |
| `src/assets/lpc_characters/guest/v0.png` | Any guest (casual clothes) |

Then tell me you're done and I'll regenerate the atlas. The other 36 variants
keep using the Pillow procedural look until you build LPC versions for them.

## Animation gaps

LPC has native walk cycles for all 4 directions. It does **not** have native sit /
carry / clean / cook poses. The loader handles this by using the LPC idle pose
for those actions and the procedural renderer adds the prop (plate, rag, etc.)
on top. You don't have to do anything special — it Just Works.

## How to revert

If you want to remove an LPC character and go back to the procedural Pillow look
for it, just delete the file. The loader checks per-variant per-role, so deleting
`src/assets/lpc_characters/chef/v3.png` makes chef variant 3 fall back to Pillow
while the others keep using their LPC sheets.
