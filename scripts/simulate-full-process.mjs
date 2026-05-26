import fs from "node:fs";
import ts from "typescript";

const recipeSource = fs.readFileSync("src/data/recipes.ts", "utf8");
const recipeModule = ts.transpileModule(recipeSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const recipeDataUrl = `data:text/javascript;base64,${Buffer.from(recipeModule).toString("base64")}`;
const { recipes } = await import(recipeDataUrl);

const ingredientUnitCost = 5;
const maxErrandOrderItems = 12;
const stockTarget = 5;
const activeRecipeIds = ["toast", "soup", "pasta", "lemonade"];
const activeRecipes = recipes.filter((recipe) => activeRecipeIds.includes(recipe.id));
const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

const state = {
  money: 100,
  pantry: Object.fromEntries(
    [...new Set(recipes.flatMap((recipe) => recipe.ingredients))].map((ingredientId) => [ingredientId, 0]),
  ),
  inTransit: {},
  preparedServings: {},
  tickets: [],
  guests: [],
  dailyServed: 0,
  dailyLost: 0,
  ratings: [],
  dirtySeats: 0,
};

Object.assign(state.pantry, {
  bread: 5,
  butter: 5,
  cheese: 4,
  pasta: 5,
  tomato: 5,
  stock: 0,
  vegetables: 5,
  herbs: 5,
  lemon: 5,
  sugar: 5,
});

const log = [];
const moneyEvents = [];

function snapshot(label) {
  log.push({
    label,
    money: state.money,
    pantry: pick(state.pantry, ["bread", "butter", "cheese", "pasta", "tomato", "stock", "vegetables", "herbs"]),
    inTransit: compactRecord(state.inTransit),
    preparedServings: compactRecord(state.preparedServings),
    tickets: state.tickets.map((ticket) => `${ticket.guestId}:${ticket.recipe.id}:${ticket.state}`),
    guests: state.guests.map((guest) => `${guest.id}:${guest.state}:${guest.order.map((recipe) => recipe.id).join("+")}`),
    served: state.dailyServed,
    lost: state.dailyLost,
    dirtySeats: state.dirtySeats,
  });
}

function spend(amount, reason) {
  if (state.money < amount) {
    moneyEvents.push({ type: "blocked-spend", reason, amount, money: state.money });
    return false;
  }
  state.money -= amount;
  moneyEvents.push({ type: "spend", reason, amount, money: state.money });
  return true;
}

function earn(amount, reason) {
  state.money += amount;
  moneyEvents.push({ type: "earn", reason, amount, money: state.money });
}

function compactRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value > 0));
}

function pick(record, keys) {
  return Object.fromEntries(keys.map((key) => [key, record[key] ?? 0]));
}

function autoShopIngredientIds(recipeIds = activeRecipeIds) {
  return new Set(recipes.filter((recipe) => recipeIds.includes(recipe.id)).flatMap((recipe) => recipe.ingredients));
}

function createBalancedErrandOrder(maxItems, recipeIds = activeRecipeIds) {
  const tracked = autoShopIngredientIds(recipeIds);
  const quantities = new Map();
  for (let index = 0; index < maxItems; index += 1) {
    const ingredient = Object.keys(state.pantry)
      .filter((ingredientId) => tracked.has(ingredientId))
      .filter((ingredientId) => (state.pantry[ingredientId] ?? 0) + (state.inTransit[ingredientId] ?? 0) + (quantities.get(ingredientId) ?? 0) < stockTarget)
      .sort((a, b) => {
        const quantityA = (state.pantry[a] ?? 0) + (state.inTransit[a] ?? 0) + (quantities.get(a) ?? 0);
        const quantityB = (state.pantry[b] ?? 0) + (state.inTransit[b] ?? 0) + (quantities.get(b) ?? 0);
        return quantityA - quantityB || a.localeCompare(b);
      })[0];
    if (!ingredient) {
      break;
    }
    quantities.set(ingredient, (quantities.get(ingredient) ?? 0) + 1);
  }
  return [...quantities.entries()].map(([ingredientId, quantity]) => ({ ingredientId, quantity }));
}

function sendErrand(order, source = "Errand") {
  const itemCount = order.reduce((sum, item) => sum + item.quantity, 0);
  const cost = itemCount * ingredientUnitCost;
  if (itemCount === 0) {
    return { sent: false, itemCount, cost };
  }
  if (!spend(cost, `${source} ingredients`)) {
    return { sent: false, itemCount, cost };
  }
  for (const item of order) {
    state.inTransit[item.ingredientId] = (state.inTransit[item.ingredientId] ?? 0) + item.quantity;
  }
  snapshot(`${source} sent: ${order.map((item) => `${item.ingredientId} x${item.quantity}`).join(", ")}`);
  for (const item of order) {
    state.inTransit[item.ingredientId] -= item.quantity;
    state.pantry[item.ingredientId] = (state.pantry[item.ingredientId] ?? 0) + item.quantity;
  }
  snapshot(`${source} delivered`);
  return { sent: true, itemCount, cost };
}

function hasIngredients(recipe) {
  return recipe.ingredients.every((ingredientId) => (state.pantry[ingredientId] ?? 0) > 0);
}

function consumeIngredients(recipe) {
  for (const ingredientId of recipe.ingredients) {
    state.pantry[ingredientId] -= 1;
  }
}

function createGuest(id, orderRecipeIds) {
  const order = orderRecipeIds.map((recipeId) => byId.get(recipeId));
  const guest = { id, order, state: "waitingToOrder", deliveredValue: 0 };
  state.guests.push(guest);
  state.tickets.push(...order.map((recipe) => ({ guestId: id, recipe, state: "ordering" })));
  snapshot(`${id} seated and ready to order`);
  return guest;
}

function takeOrder(guest) {
  state.tickets
    .filter((ticket) => ticket.guestId === guest.id && ticket.state === "ordering")
    .forEach((ticket) => {
      ticket.state = (state.preparedServings[ticket.recipe.id] ?? 0) > 0 ? "ready" : "queued";
      if (ticket.state === "ready") {
        state.preparedServings[ticket.recipe.id] -= 1;
      }
    });
  guest.state = "waitingForFood";
  snapshot(`${guest.id} order taken`);
}

function cookOneQueuedTicket() {
  const ticket = state.tickets.find((item) => item.state === "queued" && hasIngredients(item.recipe));
  if (!ticket) {
    snapshot("chef found no cookable queued ticket");
    return null;
  }
  consumeIngredients(ticket.recipe);
  ticket.state = "cooking";
  snapshot(`chef started ${ticket.recipe.name}`);
  ticket.state = "ready";
  snapshot(`chef finished ${ticket.recipe.name}`);
  return ticket;
}

function startCookingWithoutFinishing(guest, recipeId) {
  const ticket = state.tickets.find((item) => item.guestId === guest.id && item.recipe.id === recipeId && item.state === "queued");
  if (!ticket || !hasIngredients(ticket.recipe)) {
    snapshot(`could not start delayed ${recipeId} for ${guest.id}`);
    return false;
  }

  consumeIngredients(ticket.recipe);
  ticket.state = "cooking";
  snapshot(`chef started delayed ${ticket.recipe.name} for ${guest.id}`);
  return true;
}

function deliverReadyTicket(guest) {
  const ticket = state.tickets.find((item) => item.guestId === guest.id && item.state === "ready");
  if (!ticket) {
    snapshot(`no ready dish for ${guest.id}`);
    return false;
  }
  ticket.state = "delivered";
  guest.deliveredValue += ticket.recipe.sellPrice;
  snapshot(`waiter delivered ${ticket.recipe.name} to ${guest.id}`);
  if (state.tickets.filter((item) => item.guestId === guest.id).every((item) => item.state === "delivered")) {
    guest.state = "served";
    snapshot(`${guest.id} finished eating`);
  }
  return true;
}

function receivePayment(guest) {
  const payment = state.tickets
    .filter((ticket) => ticket.guestId === guest.id && ticket.state === "delivered")
    .reduce((sum, ticket) => sum + ticket.recipe.sellPrice, 0);
  earn(payment, `${guest.id} payment`);
  state.dailyServed += 1;
  state.ratings.push(payment > 0 ? 5 : 1);
  state.tickets = state.tickets.filter((ticket) => ticket.guestId !== guest.id);
  state.guests = state.guests.filter((item) => item.id !== guest.id);
  state.dirtySeats += 1;
  snapshot(`${guest.id} paid $${payment} and left`);
}

function leaveUnhappy(guest) {
  salvageAbandonedTickets(guest.id);
  state.dailyLost += 1;
  state.ratings.push(1);
  state.tickets = state.tickets.filter((ticket) => ticket.guestId !== guest.id);
  state.guests = state.guests.filter((item) => item.id !== guest.id);
  state.dirtySeats += 1;
  snapshot(`${guest.id} left unhappy`);
}

function payEarlyAfterPartialDelivery(guest) {
  salvageAbandonedTickets(guest.id);
  state.tickets = state.tickets.filter((ticket) => ticket.guestId !== guest.id || ticket.state === "delivered");
  guest.state = "served";
  snapshot(`${guest.id} patience expired after receiving something; moved to payment`);
  receivePayment(guest);
}

function salvageAbandonedTickets(guestId) {
  state.tickets
    .filter((ticket) => ticket.guestId === guestId && (ticket.state === "ready" || ticket.state === "cooking"))
    .forEach((ticket) => {
      state.preparedServings[ticket.recipe.id] = (state.preparedServings[ticket.recipe.id] ?? 0) + 1;
    });
}

snapshot("initial");

const onlyCheeseShort = createBalancedErrandOrder(maxErrandOrderItems, ["pasta"]);
sendErrand(onlyCheeseShort, "Auto-shop cheese-only check");

const happyGuest = createGuest("happy-guest", ["pasta"]);
takeOrder(happyGuest);
cookOneQueuedTicket();
deliverReadyTicket(happyGuest);
receivePayment(happyGuest);

state.preparedServings.toast = 1;
const readyPlateGuest = createGuest("ready-plate-guest", ["toast"]);
takeOrder(readyPlateGuest);
deliverReadyTicket(readyPlateGuest);
receivePayment(readyPlateGuest);

const wantedDessert = activeRecipes.some((recipe) => recipe.category === "dessert");
if (!wantedDessert) {
  state.dailyLost += 1;
  snapshot("dessert visitor turned away before seating; no matching active recipe");
}

state.pantry.stock = 0;
state.pantry.vegetables = 0;
state.pantry.herbs = 0;
snapshot("pantry drained for no-ingredients branch");
const noFoodGuest = createGuest("no-food-guest", ["soup"]);
takeOrder(noFoodGuest);
cookOneQueuedTicket();
leaveUnhappy(noFoodGuest);

state.pantry.pasta = Math.max(state.pantry.pasta, 2);
state.pantry.tomato = Math.max(state.pantry.tomato, 2);
state.pantry.cheese = Math.max(state.pantry.cheese, 2);
state.preparedServings.toast = 1;
const partialGuest = createGuest("partial-guest", ["toast", "pasta"]);
takeOrder(partialGuest);
deliverReadyTicket(partialGuest);
startCookingWithoutFinishing(partialGuest, "pasta");
payEarlyAfterPartialDelivery(partialGuest);

state.preparedServings.pasta = 0;
const abandonedGuest = createGuest("abandoned-guest", ["pasta"]);
takeOrder(abandonedGuest);
startCookingWithoutFinishing(abandonedGuest, "pasta");
leaveUnhappy(abandonedGuest);

if (state.dirtySeats > 0) {
  const cleaned = state.dirtySeats;
  state.dirtySeats = 0;
  snapshot(`waiter cleaned ${cleaned} dirty seats and moved dishes to wash station`);
}

const audit = {
  assumptions: {
    ingredientUnitCost,
    maxErrandOrderItems,
    stockTarget,
    activeRecipeIds,
  },
  keyResults: {
    cheeseOnlyOrder: onlyCheeseShort,
    finalMoney: state.money,
    moneyEvents,
    finalPreparedServings: compactRecord(state.preparedServings),
    finalPantry: pick(state.pantry, ["bread", "butter", "cheese", "pasta", "tomato", "stock", "vegetables", "herbs"]),
    served: state.dailyServed,
    lost: state.dailyLost,
    ratings: state.ratings,
  },
  trace: log,
};

console.log(JSON.stringify(audit, null, 2));
