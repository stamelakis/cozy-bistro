/**
 * Random staff-name generator. Pool is intentionally compact + readable
 * (one syllable, easy on screen) but big enough that hiring 20 staff
 * won't double up too often. Roles share the same name pool — chef
 * "Alice" and waiter "Alice" are different people and the game
 * disambiguates by role chip in the UI.
 */

const FIRST_NAMES: readonly string[] = [
  "Alex", "Sam", "Jamie", "Riley", "Casey", "Taylor", "Jordan", "Morgan",
  "Avery", "Skyler", "Quinn", "Reese", "Drew", "Hayden", "Rowan", "Logan",
  "Maya", "Nina", "Iris", "Ezra", "Theo", "Leo", "Mila", "June",
  "Aria", "Noa", "Kai", "Sage", "Wren", "Indie", "Eli", "Remy",
  "Luca", "Nico", "Ren", "Vera", "Ada", "Otto", "Mira", "Bea",
];

const LAST_NAMES: readonly string[] = [
  "Hart", "Bell", "Cole", "Day", "Frost", "Lane", "Park", "Reed",
  "Sage", "Vale", "West", "Bloom", "Fox", "Kim", "Lee", "Mendez",
  "Owens", "Pike", "Quinn", "Rivera", "Stone", "Tate", "Vega", "Webb",
  "Wood", "Yates", "Zane", "Brooks", "Carr", "Diaz", "Ellis", "Ford",
  "Gray", "Hale", "Ito", "Jung", "Kelly", "Lin", "Moss", "Noor",
];

/** Pick a "First Last" name uniformly at random. The split list keeps
 * the combinatorial space large enough that hiring lots of staff rarely
 * produces duplicates. */
export function randomStaffName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}
