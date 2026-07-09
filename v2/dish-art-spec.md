# Cozy Bistro — Dish Art Spec

Replacing the recipe emoji with real illustrated dish images (~68 dishes).
Generate one image per dish below and hand them over; I wire them in with an
emoji fallback, so tiles light up as art arrives — you don't need all 68 first.

## Technical specs (per image)
- **Square**, PNG.
- **Transparent background** preferred (the dish sits on the game's dark tiles).
  If ChatGPT won't do transparent, a plain flat cream/white background is fine —
  I'll trim it.
- 1024×1024 is fine (ChatGPT's default) — I resize + compress for the bundle,
  so don't worry about file size.
- Just the plated dish, centered. **No text, no labels, no utensils, no hands,
  no background scenery.**

## Naming — the important bit
Name each file **exactly `<id>.png`** from the list below — e.g. `garden-salad.png`,
`filet-mignon.png`. Lowercase, hyphens, matching the recipe id exactly. That's what
lets me wire all 68 in automatically instead of one by one.

## Style prompt (use the SAME wording every time — swap only the dish name)
> A cute top-down illustration of **[DISH]** plated on a simple round white plate,
> centered, on a transparent background. Soft flat colors, cozy hand-drawn
> casual-game art style, warm and appetizing, consistent soft lighting.
> No text, no utensils, no hands, no background scenery.

Consistency is the main risk across 68 separate generations. Tips: keep the prompt
identical, generate within one ChatGPT session, and after the first few add
"same art style, plate, framing, and lighting as the previous ones."

## Delivery
Drop the PNGs in a folder (or zip and send). I add a `recipeImage(id)` that returns
the image and falls back to today's emoji for anything missing — so we can ship
incrementally and it never looks broken.

## The dishes (filename → dish)

### Appetizers
- `garden-salad.png` — Garden Salad
- `bruschetta.png` — Bruschetta
- `stuffed-mushrooms.png` — Stuffed Mushrooms
- `spring-rolls.png` — Spring Rolls
- `soup.png` — Herb Soup
- `house-pickles.png` — House Pickles
- `tomato-skewers.png` — Tomato Skewers
- `pumpkin-crostini.png` — Pumpkin Crostini
- `shrimp-cups.png` — Shrimp Cups
- `truffle-bites.png` — Truffle Bites

### Mains
- `pasta.png` — Tomato Pasta
- `chicken-rice.png` — Chicken Rice
- `veggie-curry.png` — Veggie Curry
- `beef-stew.png` — Beef Stew
- `fish-tacos.png` — Fish Tacos
- `mushroom-risotto.png` — Mushroom Risotto
- `cheese-omelet.png` — Cheese Omelet
- `lentil-bowl.png` — Lentil Bowl
- `turkey-sandwich.png` — Turkey Sandwich
- `salmon-noodles.png` — Salmon Noodles
- `duck-polenta.png` — Duck Polenta
- `filet-mignon.png` — Filet Mignon
- `smash-burger.png` — Smash Burger
- `grilled-salmon.png` — Grilled Salmon
- `bbq-ribs.png` — BBQ Ribs
- `beef-skewers.png` — Beef Skewers
- `fried-chicken.png` — Fried Chicken
- `tempura.png` — Tempura
- `roast-chicken.png` — Roast Chicken
- `lasagna.png` — Lasagna
- `margherita-pizza.png` — Margherita Pizza
- `pepperoni-pizza.png` — Pepperoni Pizza
- `truffle-pizza.png` — Truffle Pizza
- `calamari.png` — Fried Calamari

### Sides
- `garlic-bread.png` — Garlic Bread
- `toast.png` — Butter Toast
- `fries.png` — Crispy Fries
- `french-fries.png` — French Fries
- `onion-rings.png` — Onion Rings
- `rice-bowl.png` — Rice Bowl
- `roasted-veg.png` — Roasted Veg
- `cheese-plate.png` — Cheese Plate
- `buttered-corn.png` — Buttered Corn
- `sweet-potatoes.png` — Sweet Potatoes
- `goat-cheese-toast.png` — Goat Cheese Toast
- `asparagus-gratin.png` — Asparagus Gratin
- `caviar-toast.png` — Caviar Toast

### Desserts
- `pancakes.png` — Pancakes
- `berry-tart.png` — Berry Tart
- `chocolate-cake.png` — Chocolate Cake
- `ice-cream.png` — Vanilla Ice Cream
- `apple-pie.png` — Apple Pie
- `honey-yogurt.png` — Honey Yogurt
- `carrot-cake.png` — Carrot Cake
- `pear-galette.png` — Pear Galette
- `pistachio-cream.png` — Pistachio Cream
- `golden-souffle.png` — Golden Souffle
- `creme-brulee.png` — Creme Brulee

### Drinks
- `lemonade.png` — Lemonade
- `iced-tea.png` — Iced Tea
- `coffee.png` — Cozy Coffee
- `berry-smoothie.png` — Berry Smoothie
- `orange-juice.png` — Orange Juice
- `mint-water.png` — Mint Water
- `spiced-cocoa.png` — Spiced Cocoa
- `matcha-latte.png` — Matcha Latte
- `rose-spritz.png` — Rose Spritz
- `saffron-tea.png` — Saffron Tea
