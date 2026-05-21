# Cozy Bistro Game Design

## Core Loop

1. Decorate the restaurant.
2. Improve attractiveness and seating.
3. Cook simple recipes.
4. Serve customers before they lose patience.
5. Earn money and reputation.
6. Buy better furniture, unlock recipes, and repeat.

## MVP Scope

The first prototype focuses on decorating and early management feedback. It should feel like a small toy that proves the room, grid, economy, and data model can support the larger game.

## Original Direction

The game should feel cozy, colorful, and social, but must remain original in identity and implementation. Inspiration is limited to the broad genre idea of a compact restaurant management game.

## Two-Player Concept

The intended couple/co-op split is:

- Player 1: decoration, budget, layout, upgrades
- Player 2: cooking, queue awareness, service flow

The MVP keeps this local and conceptual. Networking is intentionally not included yet, but systems are separated so multiplayer can later synchronize high-level commands like placing furniture, starting recipes, and serving customers.

## Data Model

Furniture includes:

- name
- cost
- size
- comfort value
- style value
- functionality type

Recipes include:

- ingredients
- preparation time
- cooking station needed
- sell price
- satisfaction effect

## Stage 1-2 Prototype Rules

- Furniture cannot overlap.
- Furniture must remain inside the room grid.
- Placing furniture spends money.
- Removing furniture gives a partial refund.
- Comfort plus style becomes the decoration score.
- Reputation and decoration score combine into attractiveness.
- Attractiveness is already exposed to the customer-flow estimate, even before full customers exist.
