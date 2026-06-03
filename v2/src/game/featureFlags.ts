/**
 * Feature flags for the server-authoritative simulation migration
 * (see docs/server-authoritative-plan.md).
 *
 * Each subsystem has its own flag so we can flip them on independently
 * as their migrations land — Phase B turns `guests` on, Phase C adds
 * `tickets`, etc. Until a flag is on, the existing client-side
 * simulation path runs unchanged. Final cutover (Phase H) flips them
 * all on by default and deletes the client-only paths.
 *
 * Runtime override: each flag reads from URL params + localStorage so
 * a tester can flip a single subsystem on for one session without
 * shipping a build. Format:
 *   - URL:   ?serverSim=guests,tickets    (comma-separated)
 *   - URL:   ?serverSim=all
 *   - URL:   ?serverSim=off               (force every flag off)
 *   - Store: localStorage["cozy-bistro.featureFlags.serverSim"]
 *            = "guests,tickets"           (same shape as the URL)
 *
 * Build-time defaults are all FALSE so production stays on the legacy
 * client sim. Don't flip these in code until a phase's migration is
 * proven on a dev build.
 *
 * The exported `featureFlags` object is read ONCE at module import.
 * That means a URL toggle takes effect on the next page load — not
 * mid-session. Intentional: switching the simulation path live would
 * leave half the game in one mode and half in the other.
 */

export interface ServerSimFlags {
  /** Phase B — guest spawning + lifecycle (state machine, patience,
   * seat assignment) live on the server. Client renders from
   * active_guest table. */
  guests: boolean;
  /** Phase C — cooking tickets (queued / cooking / ready / delivered)
   * run on the server. Client renders ticket state for the UI. */
  tickets: boolean;
  /** Phase D — staff actors (chef, waiter, barman, errand) run their
   * state machines on the server. Client lerps positions. */
  staff: boolean;
  /** Phase E — dishware pools (plate / glass per tier, clean / dirty)
   * and dishwasher batches live in tables. */
  dishware: boolean;
  /** Phase F — placed furniture lives in placed_furniture table;
   * build / move / sell go through reducers. */
  furniture: boolean;
}

const STORAGE_KEY = "cozy-bistro.featureFlags.serverSim";

/** Default (build-time) values.
 *
 * REVERTED to all-OFF after the Phase H default-on flip broke the
 * local game. GuestSpawner.update() has an early-return at
 * isServerSim("guests") that bails out to a server-driven path
 * which isn't fully implemented yet — flipping that flag on
 * stopped customer spawning entirely (and the kitchen idled
 * waiting for orders that never came). The same risk applies to
 * tickets/staff cutovers that haven't been audited end-to-end.
 *
 * The flags STILL work — opt in via URL when you're ready:
 *   ?serverSim=all                      → everything on
 *   ?serverSim=furniture,dishware       → just these two
 *   ?serverSim=off                      → all off (default)
 *
 * Furniture + dishware ARE cutover-ready (read + write + live-diff
 * shipped + verified by audit). They could safely default-on; left
 * off for now to keep "nothing changes unless you opt in" the rule
 * across the board while Phase H finishes baking. */
const DEFAULTS: ServerSimFlags = {
  guests: false,
  tickets: false,
  staff: false,
  dishware: false,
  // Phase H cutover step 1 — furniture flag flipped default-on
  // (post-H.35). Comment on the original revert called this one
  // "cutover-ready (full read + write + live-diff shipped + verified
  // by audit)"; flipping it now makes the cloud's placed_furniture
  // table the source of truth for the player's own restaurant in
  // foreground too, matching what visit mode already does for
  // others' restaurants. Mutations route through reducers; the
  // subscription drives the render tree via Engine's
  // applyCloudInsert / subscribePlacedFurnitureChanges hooks.
  //
  // Recovery: ?serverSim=off forces every flag back to false for
  // one session if this turns out to regress something.
  furniture: true,
};

/** Parse a "subsystem1,subsystem2" string into a partial flag map.
 * "all" enables everything; "off" / "none" disables everything;
 * an explicit subsystem list enables ONLY those (rest forced off).
 * The URL param and localStorage value use the same grammar.
 *
 * Subsystem-list semantics changed with the Phase H default flip:
 * pre-flip, defaults were all OFF so "furniture" meant "additionally
 * furniture". Post-flip, defaults are all ON, so the same string
 * needs to be read as "ONLY furniture, rest off" — otherwise the
 * URL override is a no-op. */
function parseFlagList(raw: string | null | undefined): Partial<ServerSimFlags> {
  if (!raw) return {};
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "off" || trimmed === "none" || trimmed === "false") {
    return { guests: false, tickets: false, staff: false, dishware: false, furniture: false };
  }
  if (trimmed === "all" || trimmed === "on" || trimmed === "true") {
    return { guests: true, tickets: true, staff: true, dishware: true, furniture: true };
  }
  // Explicit list: start from all-off, then enable the listed
  // subsystems. Result: only the listed ones are on.
  const out: ServerSimFlags = {
    guests: false, tickets: false, staff: false, dishware: false, furniture: false,
  };
  for (const tok of trimmed.split(",")) {
    const key = tok.trim();
    if (key === "guests" || key === "tickets" || key === "staff"
        || key === "dishware" || key === "furniture") {
      out[key] = true;
    }
  }
  return out;
}

/** Compute the live flag values at module-import time. URL param
 * wins (one-shot override, easy to share via link); localStorage
 * persists across sessions for a single developer. */
function computeFlags(): ServerSimFlags {
  let raw: string | null = null;
  try {
    const url = new URL(window.location.href);
    raw = url.searchParams.get("serverSim");
  } catch {
    // Non-browser context (tests / SSR) — fall through to defaults.
  }
  if (raw == null) {
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage unavailable (private window, quota) — defaults.
    }
  }
  const overrides = parseFlagList(raw);
  return { ...DEFAULTS, ...overrides };
}

/** Singleton — captured at import. Treat as read-only. To change a
 * flag for one session, set the URL param `?serverSim=guests` and
 * reload; to persist, set localStorage["cozy-bistro.featureFlags.serverSim"]
 * to the same shape. */
export const featureFlags: Readonly<ServerSimFlags> = Object.freeze(computeFlags());

/** Subsystem audit (post-commit 1fba1e7 cleanup):
 *
 * All-safe — flag-on is purely additive (mirror-gated writes only):
 *   - furniture: full read + write + live-diff (commit 6552b31 era)
 *   - guests: rewritten to additive mirror (1fba1e7); local sim always
 *             runs as source of truth
 *   - tickets: every isServerSim check is a mirror-gate inside a
 *              StaffRouter helper. Local sim runs unchanged
 *   - staff: same — mirror-gates only, no bailouts
 *
 * Publish-dependent (works when ON if the spacetime module has
 * H.4 published; without publish the local cycle countdown stops):
 *   - dishware: flag-on disables the local DishwareSystem.update()
 *               cycle countdown (intentional cutover to server H.4).
 *               If you flip this on without publishing the matching
 *               server changes, dishwasher cycles never complete.
 */
const UNSAFE_FLAGS: ReadonlySet<keyof ServerSimFlags> = new Set([
  "dishware",
]);

/** Loud console warning at module import when a publish-dependent
 * flag is on. Helps surface the cutover dependency before users
 * report "dishes never get washed". */
function warnUnsafeFlags(flags: ServerSimFlags): void {
  const on: string[] = [];
  for (const k of UNSAFE_FLAGS) {
    if (flags[k]) on.push(k);
  }
  if (on.length === 0) return;
  try {
    console.warn(
      `[featureFlags] publish-dependent serverSim flag(s) on: ${on.join(", ")}.\n`
      + "These require the latest spacetime module to be published.\n"
      + "Without publish the local cycle is disabled but the server isn't taking over yet.\n"
      + "Use ?serverSim=off in the URL to recover.",
    );
  } catch { /* console unavailable */ }
}
warnUnsafeFlags(featureFlags);

/** Convenience predicate. Equivalent to `featureFlags[subsystem]`
 * but reads better at call sites:
 *
 *     if (isServerSim("guests")) { ... server path ... }
 *     else                       { ... legacy client path ... }
 */
export function isServerSim(subsystem: keyof ServerSimFlags): boolean {
  return featureFlags[subsystem];
}
