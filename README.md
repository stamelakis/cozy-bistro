# Cozy Bistro Prototype

A cozy 2D restaurant management prototype for two-player/couple-style play. The project is inspired by the broad feeling of old social restaurant games, but uses original names, placeholder visuals, data, and mechanics.

Working names considered: **Couple Cafe**, **Tiny Table**, and **Cozy Bistro**. The prototype currently uses **Cozy Bistro** in-game.

## Current MVP

This prototype now implements Stage 1, a testable slice of Stage 2, and an early visual operations loop:

- Vite + TypeScript + Phaser 3 web game setup
- Top-down restaurant building with a visible facade, front door, dining room, and kitchen zone
- Mouse-based furniture placement
- Furniture movement and removal modes
- Furniture costs money
- Decoration score and attractiveness update as furniture changes
- Hireable chef and waiter staff
- Customers visually enter through the door, sit, order, eat, pay, and leave
- Staff visually cook, serve, collect payments, and clean tables
- Menu, recipe, order queue, and pantry panels
- Basic localStorage save for money, day, reputation, unlocked recipes, and furniture placement
- Data-driven furniture and recipe definitions
- System classes ready for cooking, customers, economy, reputation, day cycle, and saves

## Run Locally

```bash
npm install
npm run dev
```

Open the local Vite URL printed in the terminal, usually:

```text
http://127.0.0.1:5173
```

## Controls

- Click a build menu item to select furniture.
- Click the restaurant grid to place it.
- Use **Move** mode to select placed furniture, then click a new valid grid cell.
- Use **Remove** mode to sell furniture back for a partial refund.
- Hire a chef and waiter from **Restaurant Ops** to start the automated service loop.
- Buy ingredients when the pantry runs low.
- Use **Cook** mode to invite a test guest immediately.
- Use **New Game** to reset a broken save and restart with a basic crew, pantry, and starter layout.
- Use **Starter Grant** if your money drops below the amount needed to recover.
- Press `S` or click **Save** to save locally.
- Press `Esc` to clear the current selection.

## Project Structure

```text
src/
  main.ts
  scenes/
    GameScene.ts
  systems/
    RestaurantGridSystem.ts
    FurniturePlacementSystem.ts
    CookingSystem.ts
    CustomerSystem.ts
    EconomySystem.ts
    ReputationSystem.ts
    DayCycleSystem.ts
    SaveSystem.ts
  data/
    furniture.ts
    recipes.ts
    customers.ts
    upgrades.ts
  components/
    types.ts
  assets/
docs/
  game-design.md
  roadmap.md
```

## Design Boundary

No copyrighted assets, names, UI, characters, or exact mechanics from other restaurant games are included. All current visuals are simple placeholder geometry generated in Phaser.

## Next Stages

See [docs/roadmap.md](docs/roadmap.md) for the planned build order.
