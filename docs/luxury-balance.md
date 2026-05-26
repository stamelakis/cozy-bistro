# Luxury Tier Balance Notes

Cozy Bistro now uses five luxury tiers for build items and recipes.

## Unlock Rules

| Tier | Unlock point | Design intent |
| --- | --- | --- |
| 1 | Starter room | Cheap, low-risk basics. Helps the first shift run. |
| 2 | Expansion 1 | Small upgrades that make the place feel like a real cafe. |
| 3 | Expansion 2 | Mid-game variety, better service support, fuller orders. |
| 4 | Expansion 3 | Polished bistro items with meaningful rating bonuses. |
| 5 | Expansion 4+ | Premium items, expensive food, strong attraction/rating impact. |

Locked items stay visible in the UI, but are grayed out. Hover text explains which expansion unlocks the item.

## Practical Bonus Effects

| Stat | Practical effect |
| --- | --- |
| `cost` | Purchase price. Floors are charged per tile; furniture sells for less than it costs. |
| `comfort` | Improves decor quality and seat quality. Better seating encourages fuller customer orders. |
| `style` | Improves decor quality and attractiveness. Higher attractiveness increases customer flow. |
| `ratingBonus` | Directly improves experience ratings when the item contributes to the dining area. |
| `attractionBonus` | Directly improves restaurant attractiveness, increasing visitor interest. |
| `tableSeatCapacity` | Maximum usable seats assigned to that table. |
| `seatingCapacity` | How many guests one chair/bench can seat. |
| `cookingSlots` | Number of chefs that can work at that stove/range. |
| `serviceSpeedBonus` | Speeds up service/counter-related flow. Counters, sinks, and dishwashers use this. |
| recipe `sellPrice` | Customer payment per dish. Higher tiers should be more profitable but require pricier stock flow. |
| recipe `satisfactionEffect` | Raises the potential rating reward from that dish. |
| recipe `preparationTimeSeconds` | Chef/counter time needed. Longer recipes need better kitchen capacity. |

Current ingredient cost is `$5` per ingredient, so dish profit is:

```text
profit = sellPrice - ingredientCount * 5
```

Target recipe profit bands:

| Tier | Target profit |
| --- | ---: |
| 1 | `$8 - $20` |
| 2 | `$27 - $35` |
| 3 | `$45 - $57` |
| 4 | `$61 - $81` |
| 5 | `$87 - $125` |

## Auto-Ranking For Older Items

New items and recipes can set `luxuryTier` directly. Older entries without a direct tier are ranked by the game at runtime.

Furniture auto-rank value:

```text
cost + style * 16 + comfort * 10 + ratingBonus * 500 + attractionBonus * 8
```

| Value | Tier |
| --- | --- |
| `< 65` | 1 |
| `65 - 134` | 2 |
| `135 - 249` | 3 |
| `250 - 419` | 4 |
| `420+` | 5 |

Recipe auto-rank uses price and satisfaction:

| Rule | Tier |
| --- | --- |
| `sellPrice >= 88` or `satisfactionEffect >= 20` | 5 |
| `sellPrice >= 62` or `satisfactionEffect >= 15` | 4 |
| `sellPrice >= 44` or `satisfactionEffect >= 11` | 3 |
| `sellPrice >= 28` or `satisfactionEffect >= 7` | 2 |
| otherwise | 1 |

## New Furniture By Tier

| Tier | Item | Cost | Bonus / purpose |
| --- | --- | ---: | --- |
| 1 | Crate Table | 24 | Cheap 2-seat starter table. |
| 1 | Folding Chair | 12 | Cheapest seat, low comfort/style. |
| 1 | Hot Plate | 58 | Compact 1-slot cooking starter. |
| 1 | Wooden Counter | 48 | Very cheap service counter, small speed boost. |
| 1 | Tin Wash Sink | 75 | Cheapest dish station, very small service boost. |
| 1 | Manual Sink | 155 | Starter manual dish handling. |
| 1 | Welcome Mat | 18 | Small early decor/rating boost. |
| 1 | Paper Lantern | 36 | Early lighting with small rating boost. |
| 1 | Paper Menu Wall | 22 | Cheap wall attraction. |
| 1 | Plain Floor | 8 | Cheapest floor tile. |
| 2 | Painted Table | 155 | Better 4-seat table, small rating bonus. |
| 2 | Woven Chair | 130 | Better early chair, rating bonus. |
| 2 | Porcelain Sink | 420 | Cleaner early sink, small rating support. |
| 2 | Dishwasher | 650 | First automatic dish handling item. |
| 2 | Succulent Box | 150 | Small decor plus attraction. |
| 2 | Ceramic Vase | 180 | Style-focused decor. |
| 2 | Painted Floor | 45 | Better floor, small rating/attraction. |
| 3 | Family Table | 420 | 6-seat table for larger orders. |
| 3 | Host Stand | 520 | Service speed and attraction. |
| 3 | Copper Sink | 1450 | Better manual dish handling support. |
| 3 | Compact Dishwasher | 2200 | Stronger automatic dish support. |
| 3 | Brass Sconces | 460 | Mid-tier lighting attraction. |
| 3 | Soft Neon Sign | 480 | Wall attraction boost. |
| 4 | Linen Table | 900 | High style table, rating and attraction. |
| 4 | Tufted Chair | 620 | High comfort chair, rating and attraction. |
| 4 | Bistro Range | 1450 | 4 cooking slots. |
| 4 | Marble Counter | 950 | Strong service speed and rating. |
| 4 | Double Basin Sink | 4800 | High-end manual cleanup support. |
| 4 | Steam Dishwasher | 7200 | Fast polished dish automation. |
| 4 | Olive Tree | 680 | High-comfort plant decor. |
| 4 | Linen Divider | 780 | High comfort/style divider. |
| 4 | Parquet Floor | 120 | Strong floor rating/attraction. |
| 5 | Chef's Table | 1850 | Premium 6-seat table with strong rating/flow. |
| 5 | Banquette Seat | 1150 | Premium 2-seat bench. |
| 5 | Pro Kitchen Line | 2800 | 5 cooking slots plus service support. |
| 5 | Quiet Dishwasher | 15000 | Premium automatic dish handling support. |
| 5 | Auto Dish Line | 22000 | Best dish automation and service speed support. |
| 5 | Orchid Planter | 1250 | Premium plant attraction. |
| 5 | Gallery Statue | 1550 | Major style/attraction decor. |
| 5 | Crystal Lights | 1400 | Premium lighting. |
| 5 | Wine Wall | 1350 | Premium wall attraction. |
| 5 | Stone Floor | 220 | Premium floor tile. |

## New Recipes By Tier

| Tier | Recipe | Category | Sell | Time | Ingredients | Bonus / purpose |
| --- | --- | --- | ---: | ---: | --- | --- |
| 1 | House Pickles | Appetizer | 20 | 3s | vegetables, salt | Cheap starter appetizer. |
| 1 | Lentil Bowl | Main | 35 | 8s | lentils, stock, herbs | Low-cost main dish. |
| 1 | Honey Yogurt | Dessert | 25 | 3s | yogurt, honey | Fast starter dessert. |
| 1 | Mint Water | Drink | 18 | 2s | mint, lemon | Fast low-price drink. |
| 1 | Buttered Corn | Side | 25 | 4s | corn, butter | Cheap side. |
| 2 | Tomato Skewers | Appetizer | 42 | 4s | tomato, cheese, herbs | Better cafe appetizer. |
| 2 | Turkey Sandwich | Main | 50 | 5s | bread, turkey, lettuce | Fast mid-price main. |
| 2 | Carrot Cake | Dessert | 50 | 8s | carrot, flour, sugar | Better dessert profit. |
| 2 | Spiced Cocoa | Drink | 42 | 4s | cocoa, milk, spices | Warmer drink option. |
| 2 | Sweet Potatoes | Side | 45 | 7s | sweet-potato, oil, salt | Better side. |
| 3 | Pumpkin Crostini | Appetizer | 60 | 6s | bread, pumpkin, cheese | Mid-game appetizer. |
| 3 | Salmon Noodles | Main | 72 | 10s | salmon, pasta, lemon | Higher-profit main. |
| 3 | Pear Galette | Dessert | 65 | 10s | pear, flour, butter | Mid-tier dessert. |
| 3 | Matcha Latte | Drink | 60 | 4s | matcha, milk, sugar | Better drink margin. |
| 3 | Goat Cheese Toast | Side | 60 | 5s | bread, goat-cheese, honey | High-value side. |
| 4 | Shrimp Cups | Appetizer | 78 | 6s | shrimp, lettuce, lemon | Polished appetizer. |
| 4 | Duck Polenta | Main | 96 | 13s | duck, corn, butter | Long premium main. |
| 4 | Pistachio Cream | Dessert | 78 | 8s | pistachio, cream, sugar | High satisfaction dessert. |
| 4 | Rose Spritz | Drink | 76 | 5s | rose, orange, sugar | Premium drink. |
| 4 | Asparagus Gratin | Side | 78 | 9s | asparagus, cream, cheese | Higher-tier side. |
| 5 | Truffle Bites | Appetizer | 112 | 8s | truffle, mushroom, cream | Premium appetizer. |
| 5 | Filet Mignon | Main | 140 | 14s | filet, truffle, butter | Top-end main. |
| 5 | Golden Souffle | Dessert | 118 | 13s | egg, vanilla, cream | Top-end dessert. |
| 5 | Saffron Tea | Drink | 102 | 5s | saffron, tea, honey | Top-end drink. |
| 5 | Caviar Toast | Side | 120 | 5s | caviar, bread, butter | Top-end side. |

## Balance Watchpoints

- Tier 1 must stay profitable with starter staff and starter furniture.
- Tier 2 should feel affordable after the first expansion, not mandatory.
- Tier 3 is where larger tables and fuller orders should begin to matter.
- Tier 4 and 5 recipes are intentionally profitable but need better kitchen/staff layout.
- If customer flow rises faster than service capacity, first tune attraction/rating effects before raising salaries or rent.
