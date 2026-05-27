# Cozy Bistro 3D — Migration Plan

Full rewrite from 2D Phaser to 3D Three.js. The 2D game stays alive at
`/cozy-bistro/`; this version deploys to `/cozy-bistro-3d/` during
co-development. Eventually replaces the 2D version once feature parity is
reached.

## Stack

- **Engine**: Three.js (chosen for flexibility, ecosystem, browser-native)
- **Build**: Vite + TypeScript (matches existing project conventions)
- **Characters**: AI 3D generation via Meshy.ai or Tripo, seeded from the
  existing turnaround sheets in `../art_input/`
- **Furniture / world models**: Kenney + Quaternius free low-poly packs
- **Animations**: Mixamo (free human walk/idle/sit cycles), retargeted onto
  Meshy characters

## Phase plan

### Phase 1 — Project skeleton ← **WE ARE HERE**

- ✅ `v2/` directory at repo root
- ✅ Vite + TS + Three.js setup
- ✅ Iso-style orthographic camera with mouse pan/zoom/rotate
- ✅ Lit ground plane with grid overlay
- ✅ Placeholder cube + chair + table + capsule "person"

Deliverable: opening the page shows a 3D scene you can spin around.

### Phase 2 — World shell (1 week)

- Replace placeholder ground/cubes with Kenney "Restaurant Kit" or
  "Furniture Kit" models (GLTF/GLB).
- Build a `GridSystem` that converts integer cell coordinates to world
  positions, mirroring the 2D version's RestaurantGridSystem.
- Build a `WorldBuilder` that places GLTF furniture instances at grid
  positions.
- Add a building shell (walls, floor texture, door) so it actually looks
  like a restaurant.

Deliverable: a real-looking restaurant interior at rest.

### Phase 3 — Asset pipeline (1-2 weeks)

- Set up a Meshy/Tripo workflow: feed each turnaround sheet, get a rigged
  GLB back.
- Build a `CharacterLoader` that loads the GLBs and applies Mixamo
  animation clips (idle, walk, sit).
- Test all 9 existing characters (chef, waiter, errand, 6 guests) load and
  animate.

Deliverable: 9 character models walking around the empty restaurant.

### Phase 4 — Gameplay port (3-4 weeks)

Port these systems from the 2D version (they live in `../src/systems/`):

- `EconomySystem` — money, transactions, revenue/expenses
- `ReputationSystem` — rating history
- `CookingSystem` — recipes, menu, pantry
- `CustomerSystem` — order generation, expectations
- `DayCycleSystem` — time, rent, playtime
- `StaffSystem` — chef/waiter/errand management

Each system was already extracted into its own class — they should port
nearly verbatim. The rendering layer changes; the logic doesn't.

Wire them into the 3D world:

- Guests spawn at the door, navigate to a seat, sit, order.
- Chef cooks at a station, plate appears.
- Waiter picks up plate, walks to seat, serves.
- Guest "eats" (sit animation), pays, leaves.

Deliverable: full gameplay loop running in 3D.

### Phase 5 — UI rebuild (1-2 weeks)

Take the chance to redesign UI/UX since this is a full rewrite anyway:

- HTML/CSS UI overlay on top of the Three.js canvas (instead of Phaser
  canvas-based UI).
- Cleaner build menu, stats panel, staff panel.
- Touch-friendly so it works on tablet.

Deliverable: shippable UI.

### Phase 6 — Polish & launch (2 weeks)

- Particle effects (steam from stove, dust from cleaning)
- Music + SFX
- Save game compatibility layer (read old 2D saves if possible)
- Performance pass — make sure 50+ entities run smoothly
- Deploy to `/cozy-bistro/` (replacing 2D version)

## What carries over from the 2D version

**Source-of-truth assets (reused as-is or as input):**
- `../art_input/*.png` — character turnaround sheets feed Meshy
- Recipe definitions in `../src/data/recipes.ts`
- Furniture definitions in `../src/data/furniture.ts` (types + costs +
  unlock tiers; the visual representation changes but the data is the
  same)

**Code that ports nearly 1:1:**
- `../src/systems/*.ts` — pure logic, no rendering
- `../src/components/types.ts` — shared types

**Code that gets replaced wholesale:**
- `../src/scenes/GameScene.ts` (14k lines of Phaser rendering)
- `../src/data/visualAssets.ts` (2D sprite metadata)
- Anything in `../scripts/` related to sprite atlas generation

## Running v2

```bash
cd v2
npm install
npm run dev
```

Then open http://127.0.0.1:5180/

## Deploy

The existing GitHub Actions workflow builds and deploys the 2D version
from the repo root. Once Phase 6 is reached, the workflow will be updated
to build `v2/` instead and deploy to the same path. Until then, the v2
site can be deployed manually or to a separate path.
