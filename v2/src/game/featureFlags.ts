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
  /** Anti-cheat B/C — the server is the SOLE authority for
   * cloud_money_cents. When on, the client's EconomySystem is a pure
   * mirror (never writes money locally); every income flow + spend goes
   * through a server reducer and the client adopts the result. OFF until
   * the cutover is built + tested — a cheater can't be stopped while ANY
   * client still writes money, so this only protects after the default
   * flips AND the server rejects bump_cloud_money. */
  money: boolean;
  /** Phase D cutover (staff migration Pass 6) — when ON the SERVER fully
   * owns staff LOCOMOTION + state: the client stops running its local
   * StaffRouter sim + pathfinding for staff and instead lerps each body
   * toward the subscribed staff_actor row, and stops streaming positions.
   * The `staff` flag above only MIRRORS (local sim stays authoritative);
   * THIS is the actual cutover. Opt-in (default false). Test by adding
   * ?serverSim=all to the URL (enables this on top of the on-by-default
   * mirror flags); roll back by removing the param. */
  staffMove: boolean;
  /** Guest migration cutover (mirrors staffMove) — when ON the SERVER fully
   * owns the guest state machine + spawning + locomotion: the client stops
   * running its local GuestSpawner sim and instead renders each guest from
   * the subscribed active_guest row (position lerp + state-driven pose/bubble),
   * and stops mirroring local guest state UP (that upward mirror was clobbering
   * the server's authoritative state — the 0-eating divergence). Opt-in
   * (default false) until proven via ?serverSim=all, then flipped default-on. */
  guestMove: boolean;
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
  // Phase H cutover step 5 — guests flag flipped default-on.
  // The flag semantic was rewritten post-revert (commit 1fba1e7) to
  // "additionally mirror to cloud" rather than "skip local sim"; the
  // GuestSpawner.update() docstring captures the rationale. So this
  // flip just turns on the spawn / leave / position-stream mirrors
  // and unlocks visit-mode + cross-device guest visibility for the
  // owner's own restaurant. Local sim remains the source of truth
  // for now. Backgrounded play is covered by H.16+ + H.33 (server
  // spawns arrivals + runs the full state machine).
  guests: true,
  // Phase H cutover step 3 — tickets flag flipped default-on.
  // Purely additive mirror per the original audit ("every isServerSim
  // check is a mirror-gate inside a StaffRouter helper. Local sim
  // runs unchanged"). H.6 (auto-claim) + H.8 (auto-assign) +
  // H.10 (delivered handoff) make the server's tick correctly drive
  // active_ticket state on its own, so backgrounded play continues;
  // foreground keeps the StaffRouter local sim as truth and the
  // mirrors propagate to the cloud for visit mode + future co-owner
  // views.
  tickets: true,
  // Phase H cutover step 4 — staff flag flipped default-on.
  // Same shape as tickets: pure mirror-gate per original audit
  // ("same — mirror-gates only, no bailouts"). H.7 (chef release) +
  // H.8 (waiter dispatch) + H.34 (take-order) + H.35 (wash trip
  // dispatch) cover the offline simulation path; foreground play
  // keeps StaffRouter local-sim authoritative and the mirrors
  // populate staff_actor for cross-device visibility.
  staff: true,
  // Phase H cutover step 2 — dishware flag flipped default-on
  // (post-H.20 / H.21 / H.31). The original revert comment flagged
  // dishware as "publish-dependent" because flipping it disabled the
  // local DishwareSystem.update() cycle countdown, leaving cycles
  // hanging if the server didn't have H.4. H.4 has been live for
  // months; the only remaining concern was the absolute-write mirror
  // clobbering server-side wash dumps. H.31 fixed that by switching
  // every mutation to delta-based bumpDishwarePool calls.
  //
  // With the flag on:
  //   - markDirty / addClean / reserveOne / washOne push deltas (H.31)
  //   - dishwasher batches mirror via updateDishwasherBatch
  //   - DishwareSystem.update() skips its local cycle countdown
  //     because tick_dishwasher_batch (H.4) drives it server-side
  //   - subscribeDishwarePoolChanges + restoreFromCloud adopt server
  //     state as truth on connect
  dishware: true,
  // Phase H cutover step 1 — furniture flag flipped default-on
  // (post-H.35).
  furniture: true,
  // Anti-cheat B/C — money cutover, FLIPPED ON 2026-06-18. Income is
  // server-credited (sales/tips via the rollup; grants/achievement/recycle/
  // furniture-refund via dedicated reducers), the client's earn() no-ops,
  // spends post as negative cloud_money bumps, and the server
  // (money_cutover_active) rejects positive bumps so a modded client can't
  // mint money. Rollback: set this back to false AND
  // `spacetime call dunnin set_money_cutover_active false`.
  money: true,
  // Staff migration Pass 6 — the locomotion cutover. DEFAULT-ON as of
  // 2026-06-27: proven via ?serverSim=all (staff reach stations, barman
  // gets into the bar, nobody stranded outside). The client now renders
  // staff from the server pose; the legacy local locomotion path only
  // runs if explicitly disabled with ?serverSim=staffMove-off equivalents.
  staffMove: true,
  // Guest migration cutover — FLIPPED DEFAULT-ON 2026-07-04 (Phase M.16),
  // the last subsystem to go server-authoritative. The client now renders
  // guests purely from active_guest (reconcileCloudGuest + renderGuestFromServer
  // in GuestSpawner) and no longer runs its local guest sim or mirrors guest
  // state UP — that upward mirror was clobbering the server's authoritative
  // state (the "0 guests eating" divergence). Roll back by setting this false
  // and rebuilding (or ?serverSim=off for a single session).
  guestMove: true,
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
    return { guests: false, tickets: false, staff: false, dishware: false, furniture: false, money: false, staffMove: false, guestMove: false };
  }
  if (trimmed === "all" || trimmed === "on" || trimmed === "true") {
    return { guests: true, tickets: true, staff: true, dishware: true, furniture: true, money: true, staffMove: true, guestMove: true };
  }
  // Explicit list: start from all-off, then enable the listed
  // subsystems. Result: only the listed ones are on.
  const out: ServerSimFlags = {
    guests: false, tickets: false, staff: false, dishware: false, furniture: false, money: false, staffMove: false, guestMove: false,
  };
  for (const tok of trimmed.split(",")) {
    const key = tok.trim();
    if (key === "guests" || key === "tickets" || key === "staff"
        || key === "dishware" || key === "furniture" || key === "money"
        || key === "staffMove" || key === "guestMove") {
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
// Phase H cutover step 2 removed `dishware` from UNSAFE_FLAGS — the
// original "without publish the cycle stops" concern was rendered
// moot once H.4 (tick_dishwasher_batch) shipped and H.31 switched the
// mirror to deltas. Set kept around (empty) so the warning machinery
// is ready for the next subsystem that turns out to be cutover-sensitive.
const UNSAFE_FLAGS: ReadonlySet<keyof ServerSimFlags> = new Set([]);

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
