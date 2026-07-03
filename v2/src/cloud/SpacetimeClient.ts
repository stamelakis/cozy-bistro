/**
 * Bridge between the Cozy Bistro 3D Game/Engine and the
 * SpacetimeDB-published `dunnin` module (self-hosted on
 * dunnin-spacetime.ownsun.de; previously cozy-bistro-andre on
 * Maincloud, migrated off to escape energy metering).
 *
 * On Engine startup we:
 *   1. Connect (auth via a stored token; first run gets one for free).
 *   2. Subscribe to all tables so the local cache is hot.
 *   3. Either auto-create a restaurant for this player or load the
 *      saved snapshot for their first restaurant.
 *   4. Mirror local saves to the DB (debounced).
 *   5. Mirror achievement unlocks to the DB.
 *   6. Mirror end-of-day stats to the leaderboard.
 *
 * If the connection fails the game continues working from localStorage.
 */

import type { Game } from "../game/Game";
import type { SaveSystem } from "../game/SaveSystem";
import type { SaveGameState } from "../data/types";

/** Public shape of one placed_furniture row as seen by client
 * consumers — clean field names + plain JS types, no SpacetimeDB
 * internals. The cloud-side correlate is the auto-generated
 * `PlacedFurniture` interface in `cloud/generated`, which uses
 * camelCase but is otherwise the same. */
export interface PlacedFurnitureRow {
  uid: string;
  defId: string;
  x: number;
  z: number;
  rotY: number;
  floor: number;
  parentUid: string;
  slotIndex: number;
  localRotY: number;
}

/** Public shape of one dishware_pool row — one entry per (kind, tier)
 * with current clean + dirty counts. Server compacts the row when both
 * counts hit zero. */
export interface DishwarePoolRow {
  kind: "plate" | "glass";
  tier: number;
  clean: number;
  dirty: number;
}

/** Phase I (H.B) — Public shape of one dirty_pile row. One per
 * dirty plate / glass left on a table by a guest who finished their
 * meal. The host's local sim mirrors via addDirtyPile when a guest
 * leaves; subscribers (visitors + future symmetric host renderer)
 * read the cloud rows and render the leftover mesh. */
export interface DirtyPileRow {
  id: bigint;
  seatUid: string;
  kind: string;
  tier: number;
  slotIndex: number;
  floor: number;
  x: number;
  z: number;
  claimedBy: string;
}

/** Public shape of one dishwasher_batch row — mid-cycle state for one
 * placed dishwasher (keyed by furnitureUid). cycleTimeRemainingMs is
 * the milliseconds left until the batch flushes to the clean pool. */
export interface DishwasherBatchRow {
  furnitureUid: string;
  defId: string;
  plates: number;
  glasses: number;
  cycleTimeRemainingMs: bigint;
  /** H.93 — per-piece tier CSV. "5,5,3" = three plates: two T5, one
   * T3. Length matches `plates`. Empty when the batch is from a
   * pre-H.93 row that didn't track tiers. */
  platesTiers: string;
  /** H.93 — analogous to platesTiers but for glasses. */
  glassesTiers: string;
}

/** Public shape of one staff_actor row — one per active staff member.
 * Position is the live world position published by the local sim's
 * streamActorsToCloud (~1 Hz). Used by visit mode + future Phase H
 * cutover to render staff from server state. */
export interface StaffActorRow {
  memberId: string;
  role: string;
  state: string;
  x: number;
  z: number;
  floor: number;
  targetX: number;
  targetZ: number;
  targetFloor: number;
  /** Phase M.8 — facing (radians) to hold while working at the station. */
  faceY: number;
  ticketId: bigint | null;
  assignedStoveUid: string;
  washTargetUid: string;
  washPhase: string;
  /** Phase H Phase 4 — when the server's try_dispatch_take_order
   * picks a waiter to walk to a seated guest, this holds the target
   * guest's server-side id (null otherwise). The owner's bridge
   * watches the transition null→set to drive the local waiter to
   * movingToWork with the matching OrderRequest. */
  takeOrderGuestId: bigint | null;
  /** Phase H Phase 5.1+ — Errand trip phase for role="errand" actors
   * (walkingToDoor / exitingDoor / walkingToRoadEdge / offscreen /
   * walkingFromRoadEdge / enteringDoor / walkingToCounter / atCounter
   * / returningHome). Null when not on a trip. Phase 8.1 surfaces it
   * so visit-mode status bubbles can show "🛒 shopping" / "✨ home". */
  errandPhase: string | null;
  /** Phase 9.45 — when the server dispatches a STRICT seat-clean trip,
   * this holds the seat_uid of the dirty seat the waiter is bussing
   * (null otherwise). The owner's bridge watches null→set to drive the
   * local waiter to the seat, and set→null (server finished + deleted
   * the pile rows) to release them home. */
  cleanSeatUid: string | null;
}

/** Public shape of one active_guest row — one per live customer in a
 * restaurant. variant is the character model id ("guest-v3" etc.);
 * state is the lifecycle label (walkingIn / seated / ordering /
 * waitingForFood / eating / leaving / etc.). x/z are restaurant-local
 * world coords; the server steps these toward target_x/z each tick. */
export interface ActiveGuestRow {
  id: bigint;
  state: string;
  variant: string;
  archetype: string;
  x: number;
  z: number;
  floor: number;
  targetX: number;
  targetZ: number;
  targetFloor: number;
  seatUid: string;
  /** Phase H.A — Position where a plate should sit when this guest
   * is eating. Pre-H.A wasn't surfaced because the host's local sim
   * computed it from registry geometry; visit-mode visualizers need
   * it as cloud-supplied truth. */
  seatX: number;
  seatZ: number;
  seatFloor: number;
  plateX: number;
  plateZ: number;
  /** Phase H Phase 6.1 — remaining patience pool in ms. Bridge reads
   * this to distinguish an angry mid-meal leave (patience pinned to 0
   * by the server when it transitions the guest out of "eating") from
   * a natural finish (patience still positive when EATING_DURATION_MS
   * elapsed on the final course). 0 = patience timed out THIS tick. */
  patienceMs: bigint;
  /** Phase H Phase 3b — current course index. The owner's bridge
   * watches this to detect server-driven course-advance (eating →
   * seated bumps it) and fires the matching local side effects
   * (credit course, remove plate). */
  orderIndex: number;
  /** Phase H Phase 4d — comma-separated recipe ids for the visit's
   * full order. Populated by either the foreground client's
   * mirrorGuestOrder OR (after Phase 4c) by the server's
   * auto_place_next_course build_server_order fallback. Bridge
   * parses this into local g.order so creditCourse can read the
   * matching recipe + compute price/satisfaction. */
  orderRecipes: string;
}

/** Phase I.1 (H.47) — Full row shape returned by listActiveGuests.
 * GuestSpawner.hydrateFromCloud consumes this to reconstruct a
 * functional local Guest after a reload, picking up where the server
 * left off (including any H.33 server-spawned guests from the offline
 * period). Distinct from ActiveGuestRow (which is the slim shape used
 * by VisitMode's render-only subscription path). */
export interface HydratableGuestRow {
  id: bigint;
  clientTempId: string;
  variant: string;
  archetype: string;
  state: string;
  stateClockMs: bigint;
  patienceMs: bigint;
  x: number; z: number; floor: number;
  targetX: number; targetZ: number; targetFloor: number;
  seatUid: string;
  seatX: number; seatZ: number; seatFloor: number;
  seatFacingY: number;
  seatAtBar: boolean;
  plateX: number; plateZ: number;
  orderRecipes: string;
  orderIndex: number;
  ticketId: bigint | null;
  reservedDishTiers: string;
  tasteDiet: string;
  tasteDecorPref: number;
  tasteWindowPref: number;
  tasteCuisineBias: string;
  tasteDrinkTolerance: number;
  willUseToilet: boolean;
  waitingChairUid: string;
  waitingTimeoutMs: bigint;
  totalPaidCents: bigint;
  totalSatisfactionX100: number;
}

/** Public shape of one active_ticket row — one per in-flight order.
 * State is the lifecycle label (queued / waitingChef / cooking / ready
 * / pickedUp / delivered). */
export interface ActiveTicketRow {
  id: bigint;
  clientTempId: string;
  guestId: bigint;
  recipeId: string;
  state: string;
  stateClockMs: bigint;
  cookSeconds: bigint;
  assignedChefId: string;
  seatX: number;
  seatZ: number;
  seatFloor: number;
  seatAtBar: boolean;
  pickupX: number;
  pickupZ: number;
  pickupFloor: number;
  /** Phase H.A — Required appliance ("stove" | "bar" | "coffee" |
   * "toaster" | ...). Used by visualizers to pick a plate vs. glass
   * mesh for held-by-waiter / on-table renderings. */
  appliance: string;
}
import { DbConnection, type SubscriptionEventContext, type ErrorContext } from "./generated";
import { Identity } from "spacetimedb";
import { isServerSim } from "../game/featureFlags";

/** Base prefix for the stored auth token.  The actual storage key is
 * `<TOKEN_KEY_BASE>:<host-slug>` so each SpacetimeDB host gets its
 * own token slot — critical when switching between Maincloud and a
 * self-hosted instance, because a token signed by one server's
 * private key is meaningless to the other.  Without this scoping
 * the OLD Maincloud token was being sent to the new ownsun box,
 * which rejected it silently and left the connection hanging until
 * the 10 s "Server didn't respond in time" timeout fired. */
const TOKEN_KEY_BASE = "cozy-bistro-stdb-token";

/** Derive the storage key for a given host URL.  Strips protocol +
 * trailing slash + non-alphanumerics so the key is short and
 * filesystem-safe.  Examples:
 *   wss://maincloud.spacetimedb.com → maincloud-spacetimedb-com
 *   wss://dunnin-spacetime.ownsun.de → dunnin-spacetime-ownsun-de */
function tokenStorageKeyFor(host: string): string {
  const slug = host
    .replace(/^wss?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();
  return `${TOKEN_KEY_BASE}:${slug}`;
}

// Self-hosted SpacetimeDB instance (Jercy's box at ownsun.de).
// Moved off Maincloud to escape the energy-budget metering — the
// per-tick / per-mirror cadence even after the H.* optimizations
// was burning more TeV/month than the free tier allowed.  Module
// name on the new host is "dunnin" (NOT cozy-bistro-andre).
const DEFAULT_HOST = "wss://dunnin-spacetime.ownsun.de";
const DEFAULT_MODULE = "dunnin";

export interface SpacetimeConfig {
  /** Module name as published on Maincloud. */
  moduleName?: string;
  /** ws:// or wss:// host. Defaults to Maincloud. */
  host?: string;
}

/** A row from the leaderboard, joined with the player's display name. */
export interface LeaderboardRow {
  rank: number;
  playerHex: string;
  playerName: string;
  score: number;
  dayNumber: number;
  isMe: boolean;
}

/** A friendship/request entry the UI needs to render. */
export interface FriendsView {
  friends: { hex: string; name: string }[];
  incoming: { requestId: bigint; fromHex: string; fromName: string }[];
  outgoing: { requestId: bigint; toHex: string; toName: string }[];
}

/** A restaurant entry — owned by me, co-owned, or public. */
export interface RestaurantRow {
  id: bigint;
  name: string;
  ownerHex: string;
  ownerName: string;
  isPublic: boolean;
  isMine: boolean;
  isCoOwner: boolean;
}

export class SpacetimeClient {
  private readonly game: Game;
  private readonly saver: SaveSystem;
  private readonly cfg: Required<SpacetimeConfig>;
  private conn: DbConnection | null = null;
  private restaurantId: bigint | null = null;
  private identity: Identity | null = null;
  /** Set before a deliberate teardown so the auto-reconnect handler
   * doesn't fight an intentional disconnect (logout / page unload). */
  private intentionalDisconnect = false;
  /** Flips true once the socket drops unexpectedly (stays true until the
   * page reloads). The server-ownership gates consult isConnectionLive()
   * so the local sim resumes during the reconnect window instead of
   * leaving guests/staff frozen. Kept separate from `conn` so startup
   * (conn not yet established) still defers to the server as before. */
  private connectionLost = false;
  private saveDebounce: number | null = null;
  /** Engine wires this to GuestSpawner so cloudSaveNow can publish
   * the live restaurant-open state + functional-seat count. Optional
   * because cloudSaveNow runs from the SaveSystem hook before the
   * spawner exists for the first few frames; defaults at that point
   * are "open with 0 seats" which gets corrected on the next save. */
  cloudSpawnerHook?: () => { open: boolean; freeSeats: number } | null;
  /** Heartbeat timer that calls ping_presence every 30 s so this
   * player's last_seen_at stays fresh — drives the "online players"
   * HUD count. Started in afterConnect; cleared in destroy. */
  private heartbeatTimer: number | null = null;
  private wired = false;
  /** True iff the engine booted without a local save in the active slot.
   * Set by Engine before connect(). When the subscription resolves the
   * player's restaurant and finds a cloud save_snapshot, this flag tells
   * us it's safe to auto-load that snapshot into localStorage + reload
   * — there's no local progress to overwrite. Cross-device login (the
   * "same account on a second machine" case) lives entirely on this
   * code path; without it the user starts over with an empty shop. */
  private wasFreshStart = false;
  /** Latch — flips true the first time we auto-load a cloud save so a
   * subsequent table mutation doesn't trigger a reload loop. */
  private cloudAutoLoadTriggered = false;
  /** Subscribers that want to be notified when DB state mutates. UI panels
   * register a re-render here so leaderboards/friends update live. */
  private readonly listeners = new Set<() => void>();
  /** P8 chat — separate listener set fed individual ChatMessage rows
   * as they arrive, so the ChatPanel can show a desktop toast / play
   * a sound / bump an unread counter for the SPECIFIC message
   * instead of doing a full-table diff on every `notify()`. */
  private readonly chatMessageListeners = new Set<(m: { id: bigint; channel: string; senderHex: string; senderName: string; text: string; sentAtMs: number; isMine: boolean }) => void>();

  constructor(game: Game, saver: SaveSystem, cfg: SpacetimeConfig = {}) {
    this.game = game;
    this.saver = saver;
    this.cfg = {
      moduleName: cfg.moduleName ?? DEFAULT_MODULE,
      host: cfg.host ?? DEFAULT_HOST,
    };
    // On-demand console diagnostics — type `cozyDiag()` in devtools to print
    // the full cross-device load state in one clean, copy-pasteable block (no
    // fishing through the noisy console).
    try {
      (globalThis as unknown as Record<string, unknown>).cozyDiag = () => this.dumpDiagnostics();
    } catch { /* ignore */ }
  }

  /** Print the cross-device load state in one clean block. Exposed globally as
   * `cozyDiag()` for console debugging — tells us the player's identity, who
   * that identity is logged in as, which restaurant/save it resolves to, and
   * where the real save actually lives. */
  dumpDiagnostics(): void {
    const hex = (id: { toHexString(): string } | null | undefined): string => {
      try { return id ? id.toHexString() : "(none)"; } catch { return String(id); }
    };
    const meHex = hex(this.identity);
    let loggedInAs = "(my identity is in NO auth_record — not authenticated as anyone)";
    const allAuth: string[] = [];
    if (this.conn) {
      try {
        for (const a of this.conn.db.auth_record.iter()) {
          allAuth.push(`${a.username}=${hex(a.identity).slice(0, 14)}…`);
          if (this.identity && identityEquals(a.identity, this.identity)) loggedInAs = a.username;
        }
      } catch { /* ignore */ }
    }
    const rid = this.restaurantId != null ? this.restaurantId.toString() : "(none)";
    let restOwner = "(n/a)";
    if (this.conn && this.restaurantId != null) {
      try {
        const r = this.conn.db.restaurant.id.find(this.restaurantId);
        if (r) restOwner = hex(r.owner);
      } catch { /* ignore */ }
    }
    const mine = this.identity ? this.getPlayerSave(this.identity) : null;
    const mineStr = mine
      ? `day ${mine.dayNumber} / tier ${mine.luxuryTier} / $${Math.round(mine.money)}`
      : "(NONE — no player_save row for my identity)";
    // ACCOUNT-keyed save — the canonical one the current build loads.
    const myUser = this.myUsername();
    const acct = myUser ? this.getAccountSave(myUser) : null;
    const acctStr = acct
      ? `day ${acct.dayNumber} / tier ${acct.luxuryTier} / $${Math.round(acct.money)}`
      : (myUser ? "(NONE in client cache — account_save not subscribed/arrived?)" : "(no username persisted)");
    const canon = this.getCanonicalSave();
    const canonStr = canon ? `day ${canon.dayNumber} / tier ${canon.luxuryTier}` : "(none)";
    const allAccts: string[] = [];
    if (this.conn) {
      try {
        for (const a of this.conn.db.account_save.iter()) {
          allAccts.push(`${a.username}:d${a.dayNumber}/t${a.luxuryTier}`);
        }
      } catch { /* ignore */ }
    }
    const allSaves: string[] = [];
    if (this.conn) {
      try {
        for (const s of this.conn.db.player_save.iter()) {
          allSaves.push(`${hex(s.identity).slice(0, 14)}… d${s.dayNumber}/t${s.luxuryTier}`);
        }
      } catch { /* ignore */ }
    }
    let latch = "?";
    try { latch = sessionStorage.getItem("cozy-bistro.cloud-autoload-latch") ?? "(unset)"; } catch { /* ignore */ }
    const block = [
      "",
      "╔═══════ COZY DIAGNOSTICS (account-save build) ═══════",
      `║ my identity      : ${meHex}`,
      `║ logged in as     : ${loggedInAs}`,
      `║ my username      : ${myUser ?? "(NONE persisted — login didn't save it)"}`,
      `║ my restaurantId  : ${rid}  (owner ${restOwner})`,
      `║ >> account_save  : ${acctStr}`,
      `║ >> getCanonical  : ${canonStr}   <- what the build will LOAD`,
      `║ my player_save   : ${mineStr}`,
      `║ local game       : day ${this.game.day.getDayNumber()} / tier ${this.game.getLuxuryTier()}`,
      `║ wasFreshStart=${this.wasFreshStart}  latch=${latch}  loaded=${this.cloudAutoLoadTriggered}`,
      `║ all account_saves: ${allAccts.join("  |  ") || "(NONE in cache)"}`,
      `║ all auth_records : ${allAuth.join("   ") || "(none)"}`,
      "╚═════════════════════════════════════════════════════",
      "",
    ].join("\n");
    console.log(block);
  }

  /** Engine calls this before connect() to tell us whether the local
   * save was empty at boot. We use it to gate the cross-device auto
   * load — if the player walked in on a fresh device AND their cloud
   * save exists, we transparently pull it instead of starting them
   * over. */
  setWasFreshStart(fresh: boolean): void {
    this.wasFreshStart = fresh;
  }

  /** If the engine started on a truly fresh device (no localStorage)
   * AND the DB has a cloud save for this player's restaurant, pull
   * the snapshot, write it into the active slot's localStorage key,
   * and reload the page so the game restarts with the real data.
   * Called from onSubscriptionReady after restaurantId is established.
   * Latched so it only fires once per session. */
  private maybeAutoLoadCloudSave(snap: { data: string } | null, force = false): void {
    if (this.cloudAutoLoadTriggered) return;
    // PERSISTENT one-shot latch. The in-memory cloudAutoLoadTriggered flag
    // RESETS on the page reload this method triggers — so without this, a
    // forced load reload-LOOPS forever (load → reload → load …), which is
    // exactly the "loads the wrong one, goes to setup, again and again" report.
    // sessionStorage survives the reload (and the whole incognito session), so
    // the auto-load fires at most ONCE per session; a truly fresh session (all
    // incognito windows closed) clears it.
    // The latch stops a reload LOOP — but ONLY once we've actually loaded a real
    // (non-shell) game. If we're still on a day-1 SHELL while the cloud has a
    // real save, the prior load didn't take (e.g. it loaded a shell before
    // account_save arrived) — a set latch must NOT strand us there, so allow
    // another attempt. cozyDiag showed exactly this: latch=1, local=shell,
    // getCanonical=tier-5 → the latch was eating the load.
    const localIsShellForLatch = this.game.day.getDayNumber() <= 1 && this.game.getLuxuryTier() <= 1;
    let latched = false;
    try { latched = sessionStorage.getItem("cozy-bistro.cloud-autoload-latch") === "1"; } catch { /* private-mode */ }
    if (latched && !localIsShellForLatch) return;
    // `force` lets the post-login path load a RICHER cloud save over a local
    // day-1 shell even when this wasn't a fresh start — incognito tabs share
    // storage, so a stale shell can outlive wasFreshStart.
    if (!this.wasFreshStart && !force) return;
    if (!snap || typeof snap.data !== "string" || snap.data.length === 0) return;
    try {
      // Validate the payload parses BEFORE we trample the slot — a
      // corrupt cloud save shouldn't lock the player into a reload
      // loop with a busted localStorage entry.
      JSON.parse(snap.data);
    } catch (e) {
      console.warn("[SpacetimeDB] cloud save is unparseable; not auto-loading.", e);
      return;
    }
    const slot = this.saver.getActiveSlot();
    const key = slot === 1 ? "cozy-bistro-3d-save" : `cozy-bistro-3d-save-${slot}`;
    // Apply the cloud save IN-PLACE instead of write-localStorage-and-reload.
    // The reload approach RACED the autosave: the running day-1 shell saved OVER
    // the slot during the reload delay, so the reload re-loaded the shell —
    // forever (the loop the user hit). Hydrating in place makes the game the real
    // save immediately; the next autosave then persists THAT, not the shell. No
    // reload → no race → no loop.
    try {
      this.game.hydrate(JSON.parse(snap.data) as Parameters<typeof this.game.hydrate>[0]);
    } catch (e) {
      console.warn("[SpacetimeDB] cloud hydrate failed", e);
      return;
    }
    // Persist to the active slot too, so a later COLD boot finds it directly.
    try { localStorage.setItem(key, snap.data); } catch { /* best-effort */ }
    this.cloudAutoLoadTriggered = true;
    try { sessionStorage.setItem("cozy-bistro.cloud-autoload-latch", "1"); } catch { /* ignore */ }
    console.log(`[SpacetimeDB] applied cloud save in-place (slot ${slot}, day ${this.game.day.getDayNumber()}/tier ${this.game.getLuxuryTier()}) — no reload`);
  }

  // ============================================================================
  //                            AUTH (P1 multiplayer)
  // ============================================================================
  // Sign up / log in / forgot-password helpers. Wrap the SpacetimeDB
  // reducers so the LoginModal doesn't have to know about the bindings.
  // Each method returns a promise that resolves when the reducer
  // applies (success) or rejects with the server's error message.

  /** Whether this session is logged in as a valid account. Reads from
   * the auth_record cache — true when an auth_record row exists for
   * the current identity. */
  isAuthenticated(): boolean {
    if (!this.conn || !this.identity) return false;
    const me = this.identity;
    try {
      for (const r of this.conn.db.auth_record.iter()) {
        if (identityEquals(r.identity, me)) return true;
      }
    } catch { /* table not yet wired in SDK */ }
    return false;
  }

  /** Public view of a single building plot on the city map. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listBuildings(): { id: bigint; kind: string; plotX: number; plotZ: number; plotW: number; plotH: number; ownerIdentity: Identity; isMine: boolean; isUnowned: boolean }[] {
    if (!this.conn) return [];
    const me = this.identity;
    const out: { id: bigint; kind: string; plotX: number; plotZ: number; plotW: number; plotH: number; ownerIdentity: Identity; isMine: boolean; isUnowned: boolean }[] = [];
    try {
      for (const b of this.conn.db.building.iter()) {
        const mine = me ? identityEquals(b.ownerIdentity, me) : false;
        // The zero Identity is the sentinel "unowned" marker (set
        // by the seed reducer with Identity::__dummy()). Match it
        // by checking the hex is all-zero — works regardless of
        // whether the SDK exposes an Identity equality with the
        // zero value or not.
        const unowned = b.ownerIdentity.toHexString().split("").every((c) => c === "0");
        out.push({
          id: b.id,
          kind: b.kind,
          plotX: b.plotX,
          plotZ: b.plotZ,
          plotW: b.plotW,
          plotH: b.plotH,
          ownerIdentity: b.ownerIdentity,
          isMine: mine,
          isUnowned: unowned,
        });
      }
    } catch { /* table not yet wired */ }
    return out;
  }

  /** The building this player owns, or null. Returns null both for
   * "unauthenticated" and "authenticated but hasn't picked yet". */
  getMyBuilding(): { id: bigint; kind: string; plotX: number; plotZ: number; plotW: number; plotH: number } | null {
    for (const b of this.listBuildings()) {
      if (b.isMine) return b;
    }
    return null;
  }

  /** H.96 — Restaurant id this player owns, or null. Used by
   * Engine.afterAuth to detect "missing restaurant" states caused
   * by partial migrations / data wipes, and force the
   * BuildingPickModal so the user re-claims and re-creates one
   * instead of silently sitting on an empty world. */
  getMyRestaurantId(): bigint | null {
    // Lazy re-resolve: a cross-device login transfers this account's
    // restaurant.owner to the CURRENT identity (auth.rs login →
    // transfer_identity_resources) AFTER the initial subscription snapshot.
    // Subscribed to the whole city, that transfer arrives as an onUpdate
    // (owner changes on an EXISTING row), NOT an onInsert — so the onInsert
    // hook in onSubscriptionReady misses it and restaurantId stays null,
    // stranding the player on the building picker. Re-scan the live cache for
    // a restaurant owned by us whenever we don't have one resolved yet.
    if (this.restaurantId == null && this.conn && this.identity) {
      for (const r of this.conn.db.restaurant.iter()) {
        if (identityEquals(r.owner, this.identity)) {
          this.restaurantId = r.id;
          this.flushPendingActiveMenu();
          console.log(`[SpacetimeDB] restaurant ${r.id} resolved via re-scan (cross-device transfer)`);
          break;
        }
      }
    }
    return this.restaurantId;
  }

  /** Menu seed stashed while restaurantId was unresolved (new-account boot);
   * flushed by flushPendingActiveMenu once the id resolves. See setActiveMenu. */
  private pendingActiveMenuCsv: string | null = null;

  /** Flush a menu seed dropped because restaurantId wasn't known yet — notably
   * the boot active_menu seed. On a NEW account the restaurant resolves lazily
   * / after subscription, AFTER the Engine's boot menu-seed fires, so that seed
   * no-ops; without this flush active_menu stays empty and guests can never
   * order (the chef sits idle forever). Call right after setting restaurantId
   * (kept separate from the assignment so TS still narrows the field). */
  private flushPendingActiveMenu(): void {
    if (this.pendingActiveMenuCsv != null && this.conn && this.restaurantId != null) {
      try {
        this.conn.reducers.setActiveMenu({ restaurantId: this.restaurantId, recipeIds: this.pendingActiveMenuCsv });
        console.log("[SpacetimeDB] flushed pending active_menu after restaurant resolved");
      } catch (e) { console.warn("[Cloud] flush setActiveMenu failed:", e); }
      this.pendingActiveMenuCsv = null;
    }
  }

  /** Claim an unowned building. Resolves when the row updates;
   * rejects with the reducer's error message. */
  claimBuilding(buildingId: bigint): Promise<void> {
    return this.callReducer("claimBuilding", () => this.conn!.reducers.claimBuilding({ buildingId }));
  }

  /** P5.8 — record that this player just entered visit mode on
   * `host`'s plot. The host's client subscribes to visit_event and
   * surfaces a "👀 X is visiting" toast. Fire-and-forget. */
  recordVisit(host: Identity): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.recordVisit({ host });
    } catch (e) {
      console.warn("[Cloud] recordVisit failed:", e);
    }
  }

  /** Listener hook the Engine sets to receive new visit_event rows
   * where host == this player. Engine wraps the callback in a toast.
   * Returns an unsubscribe fn so Engine can detach cleanly. */
  onVisitedByOther(cb: (visitorHex: string) => void): () => void {
    this.visitListeners.add(cb);
    return () => { this.visitListeners.delete(cb); };
  }

  private readonly visitListeners = new Set<(visitorHex: string) => void>();

  /** Publish this player's save snapshot to the server. Called by
   * SaveSystem on every autosave so visitors can subscribe to the
   * latest restaurant state. Fire-and-forget — failures (offline,
   * blob too big) log to console but don't surface to the player.
   * restaurantOpen + freeSeats are read by the P5 attraction layer
   * to skip closed / full plots when picking the next walker's
   * target restaurant. */
  publishPlayerSave(blob: string, dayNumber: number, money: number, ratingAvg: number, luxuryTier: number, restaurantOpen: boolean, freeSeats: number): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.publishPlayerSave({
        data: blob,
        dayNumber,
        money: BigInt(Math.trunc(money)),
        ratingAvg,
        luxuryTier,
        restaurantOpen,
        freeSeats,
      });
    } catch (e) {
      console.warn("[Cloud] publishPlayerSave failed:", e);
    }
  }

  /** Phase J — write the ACCOUNT-keyed canonical save (account_save), keyed by
   * username so ANY session loads it (no per-identity churn). Best-effort: the
   * server accepts it only from the account's CURRENT logged-in device, so a
   * stale session's call is harmlessly rejected. Mirrors publishPlayerSave. */
  saveAccount(blob: string, dayNumber: number, money: number, ratingAvg: number, luxuryTier: number): void {
    if (!this.conn) return;
    const u = this.myUsername();
    if (!u) return;
    try {
      this.conn.reducers.saveAccount({
        username: u,
        data: blob,
        dayNumber,
        money: BigInt(Math.trunc(money)),
        ratingAvg,
        luxuryTier,
      });
    } catch (e) {
      console.warn("[Cloud] saveAccount failed:", e);
    }
  }

  /** P5 — every shared pedestrian currently walking on the server.
   * Each row is a trajectory: client lerps current position from
   * (now - spawnAtMs) / durationMs. SharedPedestrians polls this
   * each frame (cheap — small list, all in-memory). targetPlotId=0n
   * means an ambient walker; non-zero is a "customer intent" headed
   * to that plot's door. */
  listPedestrians(): { id: bigint; variant: string; startX: number; startZ: number; endX: number; endZ: number; spawnAtMs: number; durationMs: number; targetPlotId: bigint }[] {
    if (!this.conn) return [];
    const out: { id: bigint; variant: string; startX: number; startZ: number; endX: number; endZ: number; spawnAtMs: number; durationMs: number; targetPlotId: bigint }[] = [];
    try {
      for (const p of this.conn.db.pedestrian.iter()) {
        out.push({
          id: p.id,
          variant: p.variant,
          startX: p.startX,
          startZ: p.startZ,
          endX: p.endX,
          endZ: p.endZ,
          spawnAtMs: Number((p.spawnAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0)) / 1000,
          durationMs: Number(p.durationMicros) / 1000,
          targetPlotId: p.targetPlotId,
        });
      }
    } catch { /* table not yet wired */ }
    return out;
  }

  /** Count pedestrians on the server who are currently heading for
   * the given plot id. HUD reads this off the player's own claimed
   * building to surface a "N incoming" indicator — visible feedback
   * for the rating → attraction → walker spawn loop. */
  countPedestriansTargeting(plotId: bigint): number {
    if (!this.conn) return 0;
    let n = 0;
    try {
      for (const p of this.conn.db.pedestrian.iter()) {
        if (p.targetPlotId === plotId) n += 1;
      }
    } catch { /* ignore */ }
    return n;
  }

  // =====================================================================
  //                Phase B — active_guest helpers
  // =====================================================================
  // Thin wrappers around the active_guest table accessors + the spawn /
  // mark-leaving / update-position reducers. GuestSpawner (in B.3b) will
  // call these behind the `isServerSim("guests")` flag instead of
  // mutating its local guests[] array. Right now they're unused —
  // adding the surface area first so the GuestSpawner diff stays
  // smaller when it lands.

  /** Snapshot of every active_guest row belonging to my restaurant.
   * Cheap: in-memory iteration on the SpacetimeDB subscription cache.
   * Returns [] when not connected or when no restaurant is known yet.
   *
   * Phase I.1 (H.47) — expanded to return every field the local
   * GuestSpawner.hydrateFromCloud needs to reconstruct a functional
   * local Guest from a server row.  Skipped purely-server fields
   * (e.g. archetype_patience_mult — derivable from archetype). */
  /** Phase 9.2 — True when both the websocket connection AND the
   * player's restaurant id are resolved. The subscription bridges
   * (guest / staff / ticket) and the one-shot hydrates are
   * meaningless before this point — subscribe calls would silently
   * register nothing and list* calls return []. Callers use this to
   * avoid latching their once-only flags during the boot window
   * (Engine's staffReady fires on GLB load completion, which races
   * the auth + subscription flow; pre-9.2 whoever lost the race had
   * a permanently dead bridge). */
  hasRestaurantContext(): boolean {
    return this.conn != null && this.restaurantId != null;
  }

  /** Phase 9.17 — aggregation buffer for server-originated money
   * deltas so the ledger shows "Service income +$X" / "Operating
   * costs (cloud) −$X" lines (~10 s cadence) instead of nothing.
   * Pre-9.17 the balance moved invisibly and read as a dupe. */
  private pendingServerLedger = 0;
  private lastServerLedgerFlushMs = 0;
  /** Phase 9.20 — false until the first authoritative restaurant
   * row has been ADOPTED this session. Guards against the boot-seed
   * race: onSubscriptionReady seeds lastSyncedCents from a row that's
   * often still stale, defeating the null-only adoption guard and
   * narrating real offline earnings as a sudden live-income jump. */
  private moneyAdoptedThisSession = false;

  /** Phase 9.1 — Look up a single active_guest row by server id and
   * return it as a HydratableGuestRow. Used by GuestSpawner's
   * onInsert bridge to hydrate a fresh server-spawned guest, which
   * only carries the slim ActiveGuestRow shape through the
   * subscription handler; importCloudGuest needs the full taste +
   * waiting + state-clock columns from the table. */
  getHydratableGuest(id: bigint): HydratableGuestRow | null {
    if (!this.conn || this.restaurantId == null) return null;
    const rid = this.restaurantId;
    try {
      const g = this.conn.db.active_guest.id.find(id);
      if (!g || g.restaurantId !== rid) return null;
      return {
        id: g.id,
        clientTempId: g.clientTempId,
        variant: g.variant,
        archetype: g.archetype,
        state: g.state,
        stateClockMs: g.stateClockMs,
        patienceMs: g.patienceMs,
        x: g.x, z: g.z, floor: g.floor,
        targetX: g.targetX, targetZ: g.targetZ, targetFloor: g.targetFloor,
        seatUid: g.seatUid,
        seatX: g.seatX, seatZ: g.seatZ, seatFloor: g.seatFloor,
        seatFacingY: g.seatFacingY,
        seatAtBar: g.seatAtBar,
        plateX: g.plateX, plateZ: g.plateZ,
        orderRecipes: g.orderRecipes,
        orderIndex: g.orderIndex,
        ticketId: g.ticketId ?? null,
        reservedDishTiers: g.reservedDishTiers,
        tasteDiet: g.tasteDiet,
        tasteDecorPref: g.tasteDecorPref,
        tasteWindowPref: g.tasteWindowPref,
        tasteCuisineBias: g.tasteCuisineBias,
        tasteDrinkTolerance: g.tasteDrinkTolerance,
        willUseToilet: g.willUseToilet,
        waitingChairUid: g.waitingChairUid,
        waitingTimeoutMs: g.waitingTimeoutMs,
        totalPaidCents: g.totalPaidCents,
        totalSatisfactionX100: g.totalSatisfactionX100,
      };
    } catch {
      return null;
    }
  }

  listActiveGuests(): HydratableGuestRow[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: HydratableGuestRow[] = [];
    const rid = this.restaurantId;
    try {
      for (const g of this.conn.db.active_guest.iter()) {
        if (g.restaurantId !== rid) continue;
        out.push({
          id: g.id,
          clientTempId: g.clientTempId,
          variant: g.variant,
          archetype: g.archetype,
          state: g.state,
          stateClockMs: g.stateClockMs,
          patienceMs: g.patienceMs,
          x: g.x, z: g.z, floor: g.floor,
          targetX: g.targetX, targetZ: g.targetZ, targetFloor: g.targetFloor,
          seatUid: g.seatUid,
          seatX: g.seatX, seatZ: g.seatZ, seatFloor: g.seatFloor,
          seatFacingY: g.seatFacingY,
          seatAtBar: g.seatAtBar,
          plateX: g.plateX, plateZ: g.plateZ,
          orderRecipes: g.orderRecipes,
          orderIndex: g.orderIndex,
          ticketId: g.ticketId ?? null,
          reservedDishTiers: g.reservedDishTiers,
          tasteDiet: g.tasteDiet,
          tasteDecorPref: g.tasteDecorPref,
          tasteWindowPref: g.tasteWindowPref,
          tasteCuisineBias: g.tasteCuisineBias,
          tasteDrinkTolerance: g.tasteDrinkTolerance,
          willUseToilet: g.willUseToilet,
          waitingChairUid: g.waitingChairUid,
          waitingTimeoutMs: g.waitingTimeoutMs,
          totalPaidCents: g.totalPaidCents,
          totalSatisfactionX100: g.totalSatisfactionX100,
        });
      }
    } catch { /* table not yet wired (pre-publish or old build) */ }
    return out;
  }

  /** Insert a new active_guest server-side. The owner-only auth check
   * lives in the Rust reducer; this wrapper just forwards. taste*,
   * archetype, will_use_toilet come from the client-side roll using
   * the existing data/customerArchetypes.ts logic (B.3b wires the
   * call site). */
  spawnGuest(args: {
    clientTempId: string;
    variant: string;
    archetype: string;
    tasteDiet: string;
    tasteDecorPref: number;
    tasteWindowPref: number;
    tasteCuisineBias: string;
    tasteDrinkTolerance: number;
    willUseToilet: boolean;
    doorX: number;
    doorZ: number;
    doorFloor: number;
    /** H.17 — archetype patience multiplier × 100. 100 = 1.0× (server's
     *  prior flat default); 50 = impatient; 150 = heavy customer.
     *  Server scales ORDER and SERVE base patience by this so a
     *  backgrounded tab times out at the same cadence as foreground. */
    patienceMultX100: number;
    /** H.24 — pre-meal handwash flag, mirrored from GuestSpawner's
     *  spawn-time roll. Mutually exclusive with willUseToilet in the
     *  client; the server treats toilet as taking priority if both are
     *  somehow true. */
    willWashOnly: boolean;
  }): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.spawnGuest({
        restaurantId: this.restaurantId,
        clientTempId: args.clientTempId,
        variant: args.variant,
        archetype: args.archetype,
        tasteDiet: args.tasteDiet,
        tasteDecorPref: args.tasteDecorPref,
        tasteWindowPref: args.tasteWindowPref,
        tasteCuisineBias: args.tasteCuisineBias,
        tasteDrinkTolerance: args.tasteDrinkTolerance,
        willUseToilet: args.willUseToilet,
        doorX: args.doorX,
        doorZ: args.doorZ,
        doorFloor: args.doorFloor,
        patienceMultX100: args.patienceMultX100,
        willWashOnly: args.willWashOnly,
      });
    } catch (e) {
      console.warn("[Cloud] spawnGuest failed:", e);
    }
  }

  /** Find a server-side active_guest row by the client's temp id. The
   * client passes its local guest id (e.g. "guest-7") to spawnGuest;
   * after the row lands in the subscription cache, this method
   * resolves it back to the auto-inc u64 id used by other reducers.
   * Returns null until the row appears (typical latency 50-150 ms). */
  findActiveGuestIdByClientTempId(clientTempId: string): bigint | null {
    if (!this.conn || this.restaurantId == null) return null;
    const rid = this.restaurantId;
    try {
      for (const g of this.conn.db.active_guest.iter()) {
        if (g.restaurantId === rid && g.clientTempId === clientTempId) {
          return g.id;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /** Transition a guest to state="leaving" — the tick reducer deletes
   * the row after LEAVING_DWELL_MS so the client can play the walk-out
   * animation. Idempotent server-side; safe to spam. */
  markGuestLeaving(guestId: bigint): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.markGuestLeaving({ guestId });
    } catch (e) {
      console.warn("[Cloud] markGuestLeaving failed:", e);
    }
  }

  /** H.19 — Set (or clear) the overflow waiting chair assignment +
   * give-up timer on a guest's cloud row. Pass empty chairUid +
   * timeoutMs <= 0 to clear (when promoteWaitingGuests hands them a
   * real seat). Otherwise the server's H.5 dwell-then-leave branch
   * starts ticking the timeout down so a backgrounded-tab guest
   * still leaves on schedule even when the local sim isn't running. */
  setGuestWaitingChair(guestId: bigint, chairUid: string, timeoutMs: number): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.setGuestWaitingChair({
        guestId,
        chairUid,
        timeoutMs: BigInt(Math.max(0, Math.round(timeoutMs))),
      });
    } catch (e) {
      console.warn("[Cloud] setGuestWaitingChair failed:", e);
    }
  }

  /** H.20 — Push the guest's dish reservations CSV. Each entry is the
   * tier of the plate/glass reserved for that course in serve order.
   * The server uses this on despawn (settle_guest_dishes) to put
   * eaten plates into the dirty pool and refund unused reservations
   * back to clean.
   *
   * Idempotent: a no-op when the row already holds the same CSV.
   * Empty CSV is rejected server-side to avoid clobbering with stale
   * "no reservations yet" pushes. */
  setGuestReservedTiers(guestId: bigint, tiersCsv: string): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.setGuestReservedTiers({ guestId, tiersCsv });
    } catch (e) {
      console.warn("[Cloud] setGuestReservedTiers failed:", e);
    }
  }

  /** H.20 — Tell the server "I just settled this guest's dishware
   * locally (markDirty / addClean → mirrorPool already pushed the
   * post-settle absolute counts)." Sets dishes_settled = true on the
   * row so the server's own settlement path (which runs on despawn
   * delete) becomes a no-op and we don't double-count plates.
   *
   * Call BEFORE the local pool mutations so the flag mirror lands
   * before the pool-count mirrors. */
  markGuestDishesSettled(guestId: bigint): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.markGuestDishesSettled({ guestId });
    } catch (e) {
      console.warn("[Cloud] markGuestDishesSettled failed:", e);
    }
  }

  /** H.22 — Read the pending end-of-visit rollup from this player's
   * Restaurant row. Non-zero values represent guests the server
   * despawned while the foreground tab wasn't running — their
   * approximate tips + ratings + served count accumulated server-side
   * waiting for the client to come back and apply them locally.
   *
   * Returns null when the Restaurant row isn't subscribed yet OR all
   * counters are zero (nothing to apply). Caller should follow up
   * with consumePendingVisitRollup() once the values are applied to
   * Game state, atomically clearing the cloud counters. */
  getPendingVisitRollup():
    | { served: number; tipsCents: number; revenueCents: number; ratingSumX100: number; ratingCount: number; lost: number }
    | null
  {
    if (!this.conn || this.restaurantId == null) return null;
    const r = this.conn.db.restaurant.id.find(this.restaurantId);
    if (!r) return null;
    const served = Number(r.pendingServed);
    const tipsCents = Number(r.pendingTipsCents);
    const revenueCents = Number(r.pendingRevenueCents ?? 0);
    const ratingSumX100 = Number(r.pendingRatingSumX100);
    const ratingCount = Number(r.pendingRatingCount);
    // Phase 6.4 — angry-leave count accumulated during offline. Default
    // 0 covers existing cloud rows from before the column was added
    // (matches the server-side #[default(0u32)]).
    const lost = Number(r.pendingLost ?? 0);
    if (served === 0 && tipsCents === 0 && revenueCents === 0 && ratingCount === 0 && lost === 0) return null;
    return { served, tipsCents, revenueCents, ratingSumX100, ratingCount, lost };
  }

  /** H.22 — Clear the pending_* counters on this player's Restaurant
   * row. Call after getPendingVisitRollup() returned a non-null
   * snapshot AND those values have been applied to Game state. The
   * server's accumulate path always saturating-adds, so a clear that
   * races with a fresh accumulation is safe — at worst we lose ONE
   * fresh visit's contribution between the read and the clear. */
  consumePendingVisitRollup(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.consumePendingVisitRollup({ restaurantId: this.restaurantId });
    } catch (e) {
      console.warn("[Cloud] consumePendingVisitRollup failed:", e);
    }
  }

  /** H.32 — Push the current money value to the Restaurant row's
   * cloud_money_cents column. Called from the Engine update loop on
   * a few-second cadence in foreground. Visit mode + leaderboard
   * read this for a live balance instead of the autosave-stale
   * save_snapshot.money. Idempotent; no-op when the value matches. */
  syncCloudMoney(moneyDollars: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      const cents = BigInt(Math.round(moneyDollars * 100));
      this.conn.reducers.setCloudMoney({
        restaurantId: this.restaurantId,
        moneyCents: cents,
      });
    } catch (e) {
      console.warn("[Cloud] syncCloudMoney failed:", e);
    }
  }

  /** Phase 7.7 — Delta-based money sync. Adds `deltaCents` to the
   * Restaurant row's cloud_money_cents column. Coexists with
   * server-side accumulate adds (tips/revenue/etc.) without
   * overwriting them — the absolute setCloudMoney would clobber a
   * tip the server added between syncs, but a delta just adds on
   * top. Caller is responsible for computing the delta against a
   * stable baseline (EconomySystem.lastSyncedCents). No-op for 0. */
  bumpCloudMoneyCents(deltaCents: number): boolean {
    if (!this.conn || this.restaurantId == null) return false;
    if (deltaCents === 0) return false;
    try {
      this.conn.reducers.bumpCloudMoney({
        restaurantId: this.restaurantId,
        deltaCents: BigInt(deltaCents),
      });
      return true;
    } catch (e) {
      console.warn("[Cloud] bumpCloudMoneyCents failed:", e);
      return false;
    }
  }

  /** Phase M.3 — the server's ITEMIZED money ledger for this restaurant.
   * Every income + cost is a row tagged with a `kind`
   * (sale/tip/wages/rent/restock/supplies/grant/achievement/recycle/admin),
   * with the exact amount + resulting balance. The LedgerModal renders
   * these as real categorized lines instead of the lossy ~10s net-delta
   * transaction log. Newest-first (id is auto_inc → descending = reverse
   * chronological). Server prunes to ~200 rows per restaurant. */
  getMoneyEvents(): Array<{
    atMicros: number;
    kind: string;
    amountCents: number;
    balanceAfterCents: number;
  }> {
    if (!this.conn || this.restaurantId == null) return [];
    const rid = this.restaurantId;
    const rows: Array<{
      id: bigint;
      atMicros: number;
      kind: string;
      amountCents: number;
      balanceAfterCents: number;
    }> = [];
    try {
      for (const e of this.conn.db.money_event.iter()) {
        if (e.restaurantId !== rid) continue;
        rows.push({
          id: e.id,
          atMicros: Number(e.atMicros),
          kind: e.kind,
          amountCents: Number(e.amountCents),
          balanceAfterCents: Number(e.balanceAfterCents),
        });
      }
    } catch { /* money_event not synced yet (pre-publish build) */ }
    rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return rows.map(({ id: _id, ...rest }) => rest);
  }

  /** Phase M.11 — the server's time-series snapshots for this restaurant
   * (one row per ~minute, recorded continuously server-side even while the
   * owner is offline). Each row carries the customer-state counts
   * (guestsJson), staff-activity counts (staffJson), the owner-online flag,
   * money, and served/lost — the raw material for the analytics dashboard's
   * over-time graphs. Oldest-first (ascending time). Server prunes to ~12h. */
  getStatSnapshots(): Array<{
    atMicros: number;
    ownerOnline: boolean;
    cloudMoneyCents: number;
    dailyServed: number;
    dailyLost: number;
    guestsJson: string;
    staffJson: string;
  }> {
    if (!this.conn || this.restaurantId == null) return [];
    const rid = this.restaurantId;
    const rows: Array<{
      atMicros: number;
      ownerOnline: boolean;
      cloudMoneyCents: number;
      dailyServed: number;
      dailyLost: number;
      guestsJson: string;
      staffJson: string;
    }> = [];
    try {
      for (const s of this.conn.db.stat_snapshot.iter()) {
        if (s.restaurantId !== rid) continue;
        rows.push({
          atMicros: Number(s.atMicros),
          ownerOnline: s.ownerOnline,
          cloudMoneyCents: Number(s.cloudMoneyCents),
          dailyServed: s.dailyServed,
          dailyLost: s.dailyLost,
          guestsJson: s.guestsJson,
          staffJson: s.staffJson,
        });
      }
    } catch { /* stat_snapshot not synced yet (pre-publish build) */ }
    rows.sort((a, b) => a.atMicros - b.atMicros);
    return rows;
  }

  /** Anti-cheat B/C — fire the server-authoritative recurring starter
   * grant. The server enforces the 3h cooldown + plot-size amount and
   * credits cloud_money_cents; the client adopts via the restaurant
   * subscription. Server-side no-op when the cooldown isn't due, so the
   * client may call it on every enterGame. */
  claimStarterGrant(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.claimStarterGrant({ restaurantId: this.restaurantId });
    } catch (e) {
      console.warn("[Cloud] claimStarterGrant failed:", e);
    }
  }

  /** Phase 3 (money migration) — server-authoritative rent. Called on each
   * ONLINE day-rollover; the server computes RENT_BY_TIER + debits + logs a
   * "rent" money_event (grace/open re-checked server-side, no-negative floor).
   * The client adopts the debit via the restaurant subscription. */
  chargeRent(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.chargeRent({ restaurantId: this.restaurantId });
    } catch (e) {
      console.warn("[Cloud] chargeRent failed:", e);
    }
  }

  /** Anti-cheat B/C (income 2/5) — low-balance grant. Server checks the
   * balance + 24h cooldown; no-ops when not due. */
  claimLowBalanceGrant(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.claimLowBalanceGrant({ restaurantId: this.restaurantId });
    } catch (e) {
      console.warn("[Cloud] claimLowBalanceGrant failed:", e);
    }
  }

  /** Anti-cheat B/C (income 3/5) — admin money adjust (Dunnin only).
   * deltaCents may be negative (debit). */
  adminAdjustMoney(deltaCents: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.adminAdjustMoney({ restaurantId: this.restaurantId, deltaCents: BigInt(deltaCents) });
    } catch (e) {
      console.warn("[Cloud] adminAdjustMoney failed:", e);
    }
  }

  /** Dev override — SET the server balance to an exact value (admin-gated,
   * not floored). Routes the AdminModal "set money" control server-side so
   * it isn't instantly reversed by the cloud_money_cents adoption. */
  adminSetMoney(amountCents: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.adminSetMoney({ restaurantId: this.restaurantId, amountCents: BigInt(amountCents) });
    } catch (e) {
      console.warn("[Cloud] adminSetMoney failed:", e);
    }
  }

  /** Admin-only — flip the server money cutover (the anti-cheat
   * positive-bump rejection). The server rejects this unless the caller's
   * identity is is_admin (Dunnin's game account), so exposing it via a
   * console hook is safe — a non-admin caller just gets "Admin only". */
  setMoneyCutoverActive(active: boolean): void {
    if (!this.conn) {
      console.warn("[Cloud] setMoneyCutoverActive: not connected");
      return;
    }
    try {
      this.conn.reducers.setMoneyCutoverActive({ active });
      console.info(`[Cloud] requested money_cutover_active = ${active}`);
    } catch (e) {
      console.warn("[Cloud] setMoneyCutoverActive failed:", e);
    }
  }

  /** Anti-cheat B/C (income 4/5) — recycle reward ($2, 8s-rate-limited). */
  claimRecycle(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.claimRecycle({ restaurantId: this.restaurantId });
    } catch (e) {
      console.warn("[Cloud] claimRecycle failed:", e);
    }
  }

  /** Anti-cheat B/C (income 5/5) — achievement reward. Server clamps
   * per-claim + caps lifetime. rewardCents = client cashReward × 100. */
  claimAchievement(rewardCents: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.claimAchievement({ restaurantId: this.restaurantId, rewardCents: BigInt(rewardCents) });
    } catch (e) {
      console.warn("[Cloud] claimAchievement failed:", e);
    }
  }

  /** H.60 — Push the full rating-history snapshot (the rolling 1-5
   * vote list, capped at 500 entries / ~1KB) to Restaurant.  Fires
   * from ReputationSystem on every recordRating.  Idempotent
   * server-side.  Caller passes a fresh array; we serialize to
   * "v1,v2,v3,..." CSV. */
  setCloudRatingHistory(history: readonly number[]): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      // Truncate defensively in case the caller passed more than the
      // server's 4KB cap — should not happen with maxRatingHistory=500.
      const trimmed = history.length > 500 ? history.slice(-500) : history;
      const csv = trimmed.join(",");
      this.conn.reducers.setCloudRatingHistory({
        restaurantId: this.restaurantId,
        csv,
      });
    } catch (e) {
      console.warn("[Cloud] setCloudRatingHistory failed:", e);
    }
  }

  /** H.61 — Push the EconomySystem transaction log snapshot.  Caller
   * passes the array; we cap at last 100, JSON-encode, send.  The
   * server is idempotent on identical content. */
  setCloudTransactionLog(
    entries: readonly { at: number; transaction: string; amount: number; balance: number }[],
  ): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      const trimmed = entries.length > 100 ? entries.slice(-100) : entries;
      const json = JSON.stringify(trimmed);
      // Bail if the encoded form exceeds the server cap.  Shouldn't
      // happen with 100 entries (~10KB worst case) but be safe.
      if (json.length > 16000) return;
      this.conn.reducers.setCloudTransactionLog({
        restaurantId: this.restaurantId,
        json,
      });
    } catch (e) {
      console.warn("[Cloud] setCloudTransactionLog failed:", e);
    }
  }

  /** H.61 — Read the persisted transaction log off Restaurant. */
  getCloudTransactionLog(): { at: number; transaction: string; amount: number; balance: number }[] | null {
    if (!this.conn || this.restaurantId == null) return null;
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row) return null;
      const json = row.cloudTransactionLogJson;
      if (json == null || json === "") return null;
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return null;
      // Defensive shape check — drop entries missing required fields.
      return parsed.filter((e) =>
        e && typeof e.at === "number"
          && typeof e.transaction === "string"
          && typeof e.amount === "number"
          && typeof e.balance === "number");
    } catch (e) {
      console.warn("[Cloud] getCloudTransactionLog failed:", e);
      return null;
    }
  }

  /** H.63 — Push the DayHistory ring buffer snapshot.  Caller passes
   * the array; we cap at 60, JSON-encode, send.  Fires once per
   * Game.rolloverDay. */
  setCloudDayHistory(
    days: readonly unknown[],
  ): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      const trimmed = days.length > 60 ? days.slice(-60) : days;
      const json = JSON.stringify(trimmed);
      if (json.length > 16000) return;
      this.conn.reducers.setCloudDayHistory({
        restaurantId: this.restaurantId,
        json,
      });
    } catch (e) {
      console.warn("[Cloud] setCloudDayHistory failed:", e);
    }
  }

  /** Phase I (H.68) — Set the player-pinned waiter rest spot.  Pass
   * world-local x/z (same coords as furniture) + floor index.  Used
   * by the BuildMode-style sidebar tool: player clicks a tile, this
   * fires once. */
  setWaiterRestSpot(x: number, z: number, floor: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.setWaiterRestSpot({
        restaurantId: this.restaurantId,
        x, z, floor,
      });
    } catch (e) {
      console.warn("[Cloud] setWaiterRestSpot failed:", e);
    }
  }

  /** Phase I (H.68) — Clear the waiter rest spot, falling back to
   * the built-in default position. */
  clearWaiterRestSpot(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.clearWaiterRestSpot({
        restaurantId: this.restaurantId,
      });
    } catch (e) {
      console.warn("[Cloud] clearWaiterRestSpot failed:", e);
    }
  }

  /** Phase I (H.68) — Read the current waiter rest spot, or null if
   * none is set (client should fall back to the built-in default).
   * Engine calls on subscription ready + after any
   * setWaiterRestSpot / clearWaiterRestSpot reducer to refresh the
   * cached value for StaffRouter. */
  getWaiterRestSpot(): { x: number; z: number; floor: number } | null {
    if (!this.conn || this.restaurantId == null) return null;
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row || !row.waiterRestSet) return null;
      return {
        x: row.waiterRestX,
        z: row.waiterRestZ,
        floor: row.waiterRestFloor,
      };
    } catch (e) {
      console.warn("[Cloud] getWaiterRestSpot failed:", e);
      return null;
    }
  }

  /** H.63 — Read the persisted day history off Restaurant.  Returns
   * the raw JSON-parsed array; caller (DayHistory.hydrate) does the
   * shape coercion. */
  getCloudDayHistory(): unknown[] | null {
    if (!this.conn || this.restaurantId == null) return null;
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row) return null;
      const json = row.cloudDayHistoryJson;
      if (json == null || json === "") return null;
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return null;
      return parsed;
    } catch (e) {
      console.warn("[Cloud] getCloudDayHistory failed:", e);
      return null;
    }
  }

  /** H.60 — Read the persisted rating history off Restaurant.
   * Engine calls this on subscription ready and overrides the local
   * ReputationSystem's list when cloud has one.  Returns null when
   * no row exists or the column is None (legacy / fresh restaurant). */
  getCloudRatingHistory(): number[] | null {
    if (!this.conn || this.restaurantId == null) return null;
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row) return null;
      const csv = row.cloudRatingHistoryCsv;
      if (csv == null || csv === "") return null;
      return csv.split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
    } catch (e) {
      console.warn("[Cloud] getCloudRatingHistory failed:", e);
      return null;
    }
  }

  /** H.46 — Push today's running revenue + expense totals (in
   * DOLLARS — converted to cents server-side) to Restaurant for
   * visitors / leaderboard / cross-device.  Fires on the same
   * cadence as syncCloudMoney from Engine.update.  Idempotent
   * server-side; no-op when both values match the existing row. */
  syncCloudDailyTotals(revenueDollars: number, expensesDollars: number, served: number, lost: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      // Clamp to non-negative — server rejects negatives.
      const rev = Math.max(0, Math.round(revenueDollars * 100));
      const exp = Math.max(0, Math.round(expensesDollars * 100));
      this.conn.reducers.syncCloudDailyTotals({
        restaurantId: this.restaurantId,
        revenueCents: BigInt(rev),
        expensesCents: BigInt(exp),
        // Phase 6.11 — Clamp to non-negative + integer; the reducer
        // takes u32. Visitors + leaderboard read these directly off
        // the Restaurant row instead of via the autosave save_blob.
        served: Math.max(0, Math.round(served)),
        lost: Math.max(0, Math.round(lost)),
      });
    } catch (e) {
      console.warn("[Cloud] syncCloudDailyTotals failed:", e);
    }
  }

  /** H.30 — Periodic yoke of the cloud's day_elapsed_ms to this
   * client's local elapsed-in-day. Called from the Engine update
   * loop on a few-second cadence (default 5 s); prevents
   * pending_days_advanced from accumulating while the foreground tab
   * is alive — backgrounded play lets it grow until the next
   * consume_pending_day_advancement on reconnect. */
  syncDayClock(elapsedMs: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.syncDayClock({
        restaurantId: this.restaurantId,
        elapsedMs: BigInt(Math.max(0, Math.round(elapsedMs))),
      });
    } catch (e) {
      console.warn("[Cloud] syncDayClock failed:", e);
    }
  }

  /** H.30 — Read pending_days_advanced from the Restaurant row.
   * Returns 0 when the row isn't subscribed yet OR no days have
   * accumulated. Called by applyPendingDayAdvancement on reconnect. */
  getPendingDaysAdvanced(): number {
    if (!this.conn || this.restaurantId == null) return 0;
    const r = this.conn.db.restaurant.id.find(this.restaurantId);
    if (!r) return 0;
    return Number(r.pendingDaysAdvanced);
  }

  /** Phase 9.39 — Read the server's authoritative within-day clock
   * (day_elapsed_ms) so the client can adopt the correct TIME OF DAY on
   * reload instead of resetting to dawn. The server advances this every
   * tick (incl. offline), so it reflects the live time of day. Returns
   * null when the Restaurant row isn't subscribed yet. */
  getCloudDayElapsedMs(): number | null {
    if (!this.conn || this.restaurantId == null) return null;
    const r = this.conn.db.restaurant.id.find(this.restaurantId);
    if (!r) return null;
    return Number(r.dayElapsedMs);
  }

  /** Phase 9.42 — The server's current health-anomaly summary: a
   * "|"-joined list like "order_queue:18|undelivered:5|chef_hog:71", or
   * null when the kitchen is healthy / the row isn't subscribed yet. The
   * in-game health badge parses + renders it. */
  getHealthSummary(): string | null {
    if (!this.conn || this.restaurantId == null) return null;
    const r = this.conn.db.restaurant.id.find(this.restaurantId);
    if (!r) return null;
    const s = r.healthSummaryCsv;
    return s && s.length > 0 ? s : null;
  }

  /** H.30 — Atomically zero pending_days_advanced on the cloud row.
   * Caller should apply the days locally first (via N rollovers)
   * before clearing. */
  consumePendingDayAdvancement(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.consumePendingDayAdvancement({ restaurantId: this.restaurantId });
    } catch (e) {
      console.warn("[Cloud] consumePendingDayAdvancement failed:", e);
    }
  }

  /** H.30 — Read + apply + clear pending day advancement. Called
   * from onSubscriptionReady right after applyPendingVisitRollup so
   * backgrounded rent payments, daily resets, history snapshots etc.
   * land via the normal Game.rolloverDay path. Idempotent. Capped at
   * a sane MAX so a long-gone tab doesn't apply hundreds of rollovers
   * in one frame. */
  applyPendingDayAdvancement(): void {
    const pending = this.getPendingDaysAdvanced();
    if (pending === 0) return;
    /** Cap how many days we'll roll over in one shot. 30 days of
     *  rent + history is a lot of UI work for a single connect; if
     *  the player was gone for >30 days we just lose the excess. */
    const MAX_ROLLOVER = 30;
    const days = Math.min(pending, MAX_ROLLOVER);
    if (pending > MAX_ROLLOVER) {
      console.warn(`[Cloud] capping pending day rollover ${pending} → ${MAX_ROLLOVER}`);
    }
    console.log(`[Cloud] applying ${days} pending day rollover(s)`);
    // Phase 8.2 — Suppress the per-day onDayEnded callback during the
    // drain. Without this, applying 30 pending days fires 30 modal
    // shows + 30 gongs in rapid succession — visually awful. The
    // final day's stats are still captured in history because the
    // resetDailyTotals + history.push inside rolloverDay run before
    // the callback. After the loop, we fire ONE onDayEnded with the
    // most recent day's summary so the player sees the latest result.
    const savedHook = this.game.onDayEnded;
    let lastSummary: Parameters<NonNullable<typeof savedHook>>[0] | null = null;
    this.game.onDayEnded = (s) => { lastSummary = s; };
    for (let i = 0; i < days; i += 1) {
      // Phase 7.4 — Skip the local rent debit: server's tick_day_clock
      // already charged rent against cloud_money_cents for each
      // offline day past the grace window, and applyPendingVisitRollup
      // (which already ran above) adopted that cash value via Phase 7.2's
      // setMoney. Charging rent again here would visibly drop cash N
      // times after the cloud adoption — the very jolt we're trying
      // to kill. Other rollover side effects (daily resets, history
      // push, weather roll) still run; only the rent forceSpend is
      // skipped.
      this.game.rolloverDay(false);
    }
    this.game.onDayEnded = savedHook;
    if (lastSummary && savedHook) {
      savedHook(lastSummary);
    }
    this.consumePendingDayAdvancement();
  }

  /** H.28 — Push the latest furniture aggregate stats to this player's
   * Restaurant row. Called from FurnitureRegistry whenever a place /
   * move / sell mutates the local layout; the server reads these
   * cached values in accumulate_pending_visit_rollup to apply vibe +
   * bathroom rating modifiers to backgrounded guests without porting
   * the catalog data to Rust.
   *
   * Inputs are absolute (post-mutation) sums × 100 so the wire format
   * is integer. Idempotent on the server side — no-op when the
   * pushed values match what's already on the row. */
  /** Phase 9.9 — In-flight recipe upgrade deadlines from the cloud.
   * The server's restaurant_tick completes these while the tab is
   * closed (deadline row deleted + recipe id appended to the
   * pending-completions CSV), so on reload the CLOUD list is the
   * truth: a local-save timer with no matching row here is either
   * already completed (drained separately) or never started. */
  listRecipeUpgradesInFlight(): { recipeId: string; completesAtMs: number }[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: { recipeId: string; completesAtMs: number }[] = [];
    try {
      for (const r of this.conn.db.recipe_upgrade_in_flight.iter()) {
        if (r.restaurantId !== this.restaurantId) continue;
        out.push({
          recipeId: r.recipeId,
          completesAtMs: Number(r.completesAtMicros) / 1000,
        });
      }
    } catch { /* table not wired pre-publish */ }
    return out;
  }

  /** Phase 9.19 — Mirror the player's auto-shop stock target so the
   * server's errand dispatcher shops toward it instead of its old
   * hardcoded below-3-units floor. Engine pushes on boot + whenever
   * the player adjusts the +/- control. */
  setPantryTarget(target: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.setPantryTarget({
        restaurantId: this.restaurantId,
        target: Math.max(1, Math.round(target)),
      });
    } catch (e) {
      console.warn("[Cloud] setPantryTarget failed:", e);
    }
  }

  /** Phase 9.7 — Replace the server's seat_slot rows with the
   * client's freshly resolved seat list. Entries are
   * "seat_uid;x;z;floor;facing;plate_x;plate_z;at_bar" joined "|".
   * Fired from FurnitureRegistry alongside updateRestaurantAggregates
   * on every placement mutation. */
  replaceSeatSlots(slotsCsv: string): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.replaceSeatSlots({
        restaurantId: this.restaurantId,
        slotsCsv,
      });
    } catch (e) {
      console.warn("[Cloud] replaceSeatSlots failed:", e);
    }
  }

  updateRestaurantAggregates(
    styleX100: number,
    comfortX100: number,
    ratingBonusX100: number,
    bathroomQualityX100: number,
    attractionBonusX100: number,
  ): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.updateRestaurantAggregates({
        restaurantId: this.restaurantId,
        styleX100: Math.round(styleX100),
        comfortX100: Math.round(comfortX100),
        ratingBonusX100: Math.round(ratingBonusX100),
        bathroomQualityX100: Math.round(bathroomQualityX100),
        // Phase 6.6 — feeds try_server_spawn_guest's attraction
        // multiplier so a well-decorated restaurant spawns at the
        // same accelerated rate offline as it does online.
        attractionBonusX100: Math.round(attractionBonusX100),
      });
    } catch (e) {
      console.warn("[Cloud] updateRestaurantAggregates failed:", e);
    }
  }

  /** Phase 6.10 — Read the Restaurant row's boost_expires_at_micros.
   * Returns null when no row is subscribed yet OR the column was
   * never set (default 0 from the schema means "never boosted"). The
   * caller treats 0 / null identically — Game.restoreBoostStateFromCloud
   * clears both timers. */
  getCloudBoostExpiresAtMicros(): number | null {
    if (!this.conn || this.restaurantId == null) return null;
    const r = this.conn.db.restaurant.id.find(this.restaurantId);
    if (!r) return null;
    const micros = Number(r.boostExpiresAtMicros ?? 0n);
    return micros;
  }

  /** Phase 6.7 — push the foreground boost expiry to the cloud so
   * try_server_spawn_guest can apply the same 0.5× spawn interval
   * halving while the owner's tab is backgrounded. Without this push,
   * a paid boost only accelerates spawns for the duration the tab
   * stays foreground; the rest of the boost window reverts to the
   * unboosted 5.5s cadence on the server.
   *
   * `expiresAtMs` is wall-clock ms (Date.now() + boostDurationMs);
   * caller converts to micros for the i64 cloud column. Passing 0
   * clears the boost early (e.g. an admin reset). */
  setBoostExpiresAt(expiresAtMs: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.setBoostExpiresAt({
        restaurantId: this.restaurantId,
        expiresAtMicros: BigInt(Math.round(expiresAtMs * 1000)),
      });
    } catch (e) {
      console.warn("[Cloud] setBoostExpiresAt failed:", e);
    }
  }

  /** H.22 — Read + apply + clear in one shot. Calls getPendingVisitRollup;
   * if non-null, applies the values to Game state (money, served,
   * reputation) and then clears the cloud counters. Idempotent if no
   * rollup is pending. Safe to call repeatedly. */
  applyPendingVisitRollup(): void {
    const rollup = this.getPendingVisitRollup();
    if (!rollup) return;
    // Phase 7.2 — Money cloud-canonical on reconnect. The server has
    // ALREADY updated cloud_money_cents during offline accumulate
    // (line 1554 of accumulate_pending_visit_rollup adds tip + revenue
    // to the cloud column). Previously we ALSO called earnMoney here
    // — which bumped the local balance + fired transaction-log entries
    // + animated the running balance climb. That created the "cash
    // jumps up on reload" jolt the user reported.
    //
    // The fix: adopt cloud_money_cents as the local truth on reconnect
    // — single setMoney call, no per-transaction animation, no
    // ledger pollution from N "offline" entries. The values are
    // intentionally still in rollup.tipsCents + rollup.revenueCents so
    // we can log the total breakdown for the player; we just don't
    // re-apply them to the balance.
    if (this.restaurantId != null) {
      const restRow = this.conn?.db.restaurant.id.find(this.restaurantId);
      if (restRow != null) {
        const cloudCents = Number(restRow.cloudMoneyCents);
        const cloudDollars = cloudCents / 100;
        // Phase 9.25 — adopt the cloud balance AND record a labelled
        // ledger line for the gap. This setMoney was previously
        // SILENT, so a returning session whose local save lagged the
        // (canonical) cloud by the server's between-save earnings
        // showed a $100k+ balance jump with NO ledger entry — it
        // read as fabricated money. setMoney REPLACES (local→cloud,
        // can't dupe); the line just explains where the jump came
        // from. Also claim the session adoption so the
        // restaurant.onUpdate first-contact handler doesn't re-jump
        // the same gap a second time.
        const before = this.game.economy.getMoney();
        const recon = cloudDollars - before;
        if (Math.abs(recon) >= 0.01) {
          this.game.economy.setMoney(cloudDollars);
          if (Math.abs(recon) >= 1) {
            this.game.economy.recordTransaction(
              recon >= 0
                ? "Reconciled — earnings while away"
                : "Reconciled — costs while away",
              recon,
            );
          }
        }
        // Phase 7.7 — Align the delta-sync baseline with the cloud
        // value we just adopted, so the next 5s sync push doesn't
        // try to re-bump for the gap that's already reconciled.
        this.game.economy.noteSyncedCents(cloudCents);
        // Phase 9.25 — this WAS the session's money adoption; flag it
        // so the onUpdate first-contact path takes the delta branch.
        this.moneyAdoptedThisSession = true;
      }
    }
    // Served counter — bumps the HUD's "served today" + drives
    // achievements that watch the total. Cloud carries one count for
    // each pending guest already despawned by the server.
    if (rollup.served > 0) {
      this.game.customers.recordServed(rollup.served);
    }
    // Phase 6.4 — angry-leave counter (server bumps pending_lost when
    // a guest is despawned with order_index == 0, matching client's
    // recordLost semantics where eat-mid-course angry-leavers still
    // count as served via finalizeVisit). Without this, the HUD's
    // "lost customers" total under-reports after any offline period
    // that had patience / waiting-chair timeouts.
    if (rollup.lost > 0) {
      this.game.customers.recordLost(rollup.lost);
    }
    // Phase 7.1 — Rating cloud-canonical. We USED to call
    // recordRating(avg) N times here, which slammed the local
    // ratingHistory with N copies of the average — turning a 23-guest
    // offline angry-leave window into a brutal "rating crashed" jolt
    // on reload. The server now appends each freshly-computed rating
    // directly to cloud_rating_history_csv inside the same
    // accumulate_pending_visit_rollup call, so cloud carries the
    // per-guest history. After this consume drains the legacy pending
    // counters, hydrate the local ReputationSystem from the cloud CSV
    // — that adopts the server's actual record without re-recording
    // anything locally. pending_rating_sum/count still cleared by the
    // server-side consume; the client just stops using them.
    void rollup.ratingCount;
    void rollup.ratingSumX100;
    const cloudHistory = this.getCloudRatingHistory();
    if (cloudHistory) {
      this.game.reputation.applyCloudRatingHistory(cloudHistory);
    }
    console.log(
      `[Cloud] applied pending visit rollup — ${rollup.served} guests, ${rollup.lost} lost, ` +
      `$${(rollup.tipsCents / 100).toFixed(2)} tips, ` +
      `${rollup.ratingCount} ratings (avg ${(rollup.ratingSumX100 / Math.max(1, rollup.ratingCount) / 100).toFixed(1)})`
    );
    this.consumePendingVisitRollup();
  }

  /** H.11 / H.14 — Set the guest's full course list on the server so
   * the tick reducer can drive the multi-course eating cycle AND
   * autonomously place the next course's ticket (H.14
   * auto_place_next_course). Called by GuestSpawner once per guest
   * after buildOrder populates g.order. Idempotent.
   *
   * Five parallel CSVs (same length per course):
   *   - recipesCsv: recipe ids in serve order
   *   - appliancesCsv: required appliance per course
   *   - cookSecondsCsv: base cook time in ms per course (u32 string)
   *   - pricesCsv: effective sell price in cents per course (i64)
   *   - satisfactionsCsv: effective satisfaction × 100 per course (i32),
   *     including the +200 cuisine-preference bonus when applicable
   *
   * Empty recipesCsv clears the order. */
  setGuestOrder(
    guestId: bigint,
    recipesCsv: string,
    appliancesCsv: string,
    cookSecondsCsv: string,
    pricesCsv: string,
    satisfactionsCsv: string,
  ): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.setGuestOrder({
        guestId, recipesCsv, appliancesCsv, cookSecondsCsv,
        pricesCsv, satisfactionsCsv,
      });
    } catch (e) {
      console.warn("[Cloud] setGuestOrder failed:", e);
    }
  }

  /** Stream body position + next target up to the server. Called by
   * GuestSpawner's per-frame walker — throttled to ~5 Hz by the
   * caller. Targets feed any future "render this guest from another
   * client's view" path (P4 visit mode + co-owner mirroring). */
  updateGuestPosition(guestId: bigint, x: number, z: number, floor: number,
                      targetX: number, targetZ: number, targetFloor: number,
                      state: string): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.updateGuestPosition({
        guestId, x, z, floor, targetX, targetZ, targetFloor, state,
      });
    } catch (e) {
      console.warn("[Cloud] updateGuestPosition failed:", e);
    }
  }

  // =====================================================================
  //                Phase C — active_ticket helpers
  // =====================================================================
  // Matching wrappers for the place_order / claim_ticket / finish_cooking
  // / pickup_ticket / deliver_ticket / cancel_ticket reducers. StaffRouter
  // (Phase C.3b) calls these behind the isServerSim("tickets") flag to
  // mirror its local Ticket lifecycle to the server's active_ticket
  // table. Same pattern + correlation strategy as active_guest:
  //   - client passes its local Ticket id as client_temp_id
  //   - after a brief await the resolved server u64 id is stashed
  //     on the local Ticket for subsequent transition calls.

  /** Snapshot every active_ticket row belonging to my restaurant. */
  listActiveTickets(): ActiveTicketRow[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: ReturnType<SpacetimeClient["listActiveTickets"]> = [];
    const rid = this.restaurantId;
    try {
      for (const t of this.conn.db.active_ticket.iter()) {
        if (t.restaurantId !== rid) continue;
        out.push({
          id: t.id,
          clientTempId: t.clientTempId,
          guestId: t.guestId,
          recipeId: t.recipeId,
          state: t.state,
          stateClockMs: t.stateClockMs,
          cookSeconds: t.cookSecondsMs,
          assignedChefId: t.assignedChefId,
          seatX: t.seatX,
          seatZ: t.seatZ,
          seatFloor: t.seatFloor,
          seatAtBar: t.seatAtBar,
          pickupX: t.pickupX,
          pickupZ: t.pickupZ,
          pickupFloor: t.pickupFloor,
          appliance: t.appliance,
        });
      }
    } catch { /* table not wired yet (pre-publish build) */ }
    return out;
  }

  /** Resolve a server-side ticket id from the client's correlation id.
   * Returns null until the row materialises after spawn (50-150 ms). */
  findActiveTicketIdByClientTempId(clientTempId: string): bigint | null {
    if (!this.conn || this.restaurantId == null) return null;
    const rid = this.restaurantId;
    try {
      for (const t of this.conn.db.active_ticket.iter()) {
        if (t.restaurantId === rid && t.clientTempId === clientTempId) {
          return t.id;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /** Open a new ticket bound to a specific server-side guest. */
  placeOrder(args: {
    guestId: bigint;
    clientTempId: string;
    recipeId: string;
    baseCookSecondsMs: bigint;
    appliance: string;
    seatX: number;
    seatZ: number;
    seatFloor: number;
    seatAtBar: boolean;
  }): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.placeOrder({
        guestId: args.guestId,
        clientTempId: args.clientTempId,
        recipeId: args.recipeId,
        baseCookSecondsMs: args.baseCookSecondsMs,
        appliance: args.appliance,
        seatX: args.seatX,
        seatZ: args.seatZ,
        seatFloor: args.seatFloor,
        seatAtBar: args.seatAtBar,
      });
    } catch (e) {
      console.warn("[Cloud] placeOrder failed:", e);
    }
  }

  claimTicket(ticketId: bigint, chefMemberId: string, cookSecondsMs: bigint): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.claimTicket({ ticketId, chefMemberId, cookSecondsMs });
    } catch (e) {
      console.warn("[Cloud] claimTicket failed:", e);
    }
  }

  finishCooking(ticketId: bigint, pickupX: number, pickupZ: number, pickupFloor: number): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.finishCooking({ ticketId, pickupX, pickupZ, pickupFloor });
    } catch (e) {
      console.warn("[Cloud] finishCooking failed:", e);
    }
  }

  pickupTicket(ticketId: bigint): void {
    if (!this.conn) return;
    try { this.conn.reducers.pickupTicket({ ticketId }); }
    catch (e) { console.warn("[Cloud] pickupTicket failed:", e); }
  }

  deliverTicket(ticketId: bigint): void {
    if (!this.conn) return;
    try { this.conn.reducers.deliverTicket({ ticketId }); }
    catch (e) { console.warn("[Cloud] deliverTicket failed:", e); }
  }

  cancelTicket(ticketId: bigint): void {
    if (!this.conn) return;
    try { this.conn.reducers.cancelTicket({ ticketId }); }
    catch (e) { console.warn("[Cloud] cancelTicket failed:", e); }
  }

  // =====================================================================
  //                Phase D — staff_actor helpers
  // =====================================================================
  // Thin wrappers around the register / update / unregister reducers.
  // StaffRouter (Phase D.3b) calls these behind isServerSim("staff").
  // No client_temp_id correlation needed because staff actors use the
  // client's HiredStaffMember.id as the primary key directly.

  /** Read every staff_actor row for the current restaurant. Used by
   * StaffRouter at boot if the staff cutover (Phase H) is on — for
   * now the local sim seeds actors from the JSON save instead. Visit
   * mode (P4) reads this to render the visited restaurant's staff. */
  listStaffActors(): (StaffActorRow & { homeFloor: number })[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: (StaffActorRow & { homeFloor: number })[] = [];
    const rid = this.restaurantId;
    try {
      for (const a of this.conn.db.staff_actor.iter()) {
        if (a.restaurantId !== rid) continue;
        out.push({
          memberId: a.memberId,
          role: a.role,
          state: a.state,
          homeFloor: a.homeFloor,
          x: a.x,
          z: a.z,
          floor: a.floor,
          targetX: a.targetX,
          targetZ: a.targetZ,
          targetFloor: a.targetFloor,
          faceY: a.faceY,
          ticketId: a.ticketId ?? null,
          assignedStoveUid: a.assignedStoveUid,
          washTargetUid: a.washTargetUid,
          washPhase: a.washPhase,
          takeOrderGuestId: a.takeOrderGuestId ?? null,
          errandPhase: a.errandPhase ?? null,
          cleanSeatUid: a.cleanSeatUid ?? null,
        });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Subscribe to live staff_actor changes for the current restaurant.
   * Used by P4 visit mode to animate the visited restaurant's staff
   * in real time. Filters by restaurantId so each visitor only sees
   * the host they're currently watching.
   *
   * NOTE: NOT WIRED YET on the player's own session — both devices
   * running a local sim would otherwise fight over each actor's
   * position. Final cutover (Phase H) flips this on for the owner
   * once the server-side staff state machine takes over the writes. */
  subscribeStaffActorChanges(handlers: {
    onInsert?: (row: StaffActorRow) => void;
    onUpdate?: (row: StaffActorRow) => void;
    onDelete?: (memberId: string) => void;
  }, restaurantId?: bigint): void {
    if (!this.conn) return;
    const rid = restaurantId ?? this.restaurantId;
    if (rid == null) return;
    type ServerRow = {
      memberId: string; restaurantId: bigint; role: string; state: string;
      x: number; z: number; floor: number;
      targetX: number; targetZ: number; targetFloor: number;
      faceY: number;
      ticketId: bigint | undefined;
      assignedStoveUid: string; washTargetUid: string; washPhase: string;
      takeOrderGuestId: bigint | undefined;
      errandPhase: string | undefined;
      cleanSeatUid: string | undefined;
    };
    const toClientRow = (r: ServerRow): StaffActorRow => ({
      memberId: r.memberId, role: r.role, state: r.state,
      x: r.x, z: r.z, floor: r.floor,
      targetX: r.targetX, targetZ: r.targetZ, targetFloor: r.targetFloor,
      faceY: r.faceY,
      ticketId: r.ticketId ?? null,
      assignedStoveUid: r.assignedStoveUid,
      washTargetUid: r.washTargetUid,
      washPhase: r.washPhase,
      takeOrderGuestId: r.takeOrderGuestId ?? null,
      errandPhase: r.errandPhase ?? null,
      cleanSeatUid: r.cleanSeatUid ?? null,
    });
    try {
      if (handlers.onInsert) {
        this.conn.db.staff_actor.onInsert((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onInsert!(toClientRow(row));
        });
      }
      if (handlers.onUpdate) {
        this.conn.db.staff_actor.onUpdate((_ctx, _old: ServerRow, newRow: ServerRow) => {
          if (newRow.restaurantId !== rid) return;
          handlers.onUpdate!(toClientRow(newRow));
        });
      }
      if (handlers.onDelete) {
        this.conn.db.staff_actor.onDelete((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onDelete!(row.memberId);
        });
      }
    } catch (e) {
      console.warn("[Cloud] subscribeStaffActorChanges failed:", e);
    }
  }

  /** Subscribe to live active_guest changes for the current restaurant
   * (or for a different restaurant if `restaurantId` is passed —
   * visit mode does this to watch a host's customers in real time).
   * Same row-filter pattern as the others. */
  subscribeActiveGuestChanges(handlers: {
    onInsert?: (row: ActiveGuestRow) => void;
    onUpdate?: (row: ActiveGuestRow) => void;
    onDelete?: (id: bigint) => void;
  }, restaurantId?: bigint): void {
    if (!this.conn) return;
    const rid = restaurantId ?? this.restaurantId;
    if (rid == null) return;
    type ServerRow = {
      id: bigint; restaurantId: bigint; state: string; variant: string; archetype: string;
      patienceMs: bigint;
      x: number; z: number; floor: number;
      targetX: number; targetZ: number; targetFloor: number;
      seatUid: string;
      seatX: number; seatZ: number; seatFloor: number;
      plateX: number; plateZ: number;
      orderIndex: number;
      orderRecipes: string;
    };
    const toClientRow = (r: ServerRow): ActiveGuestRow => ({
      id: r.id, state: r.state, variant: r.variant, archetype: r.archetype,
      patienceMs: r.patienceMs,
      x: r.x, z: r.z, floor: r.floor,
      targetX: r.targetX, targetZ: r.targetZ, targetFloor: r.targetFloor,
      seatUid: r.seatUid,
      seatX: r.seatX, seatZ: r.seatZ, seatFloor: r.seatFloor,
      plateX: r.plateX, plateZ: r.plateZ,
      orderIndex: r.orderIndex,
      orderRecipes: r.orderRecipes,
    });
    try {
      if (handlers.onInsert) {
        this.conn.db.active_guest.onInsert((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onInsert!(toClientRow(row));
        });
      }
      if (handlers.onUpdate) {
        this.conn.db.active_guest.onUpdate((_ctx, _old: ServerRow, newRow: ServerRow) => {
          if (newRow.restaurantId !== rid) return;
          handlers.onUpdate!(toClientRow(newRow));
        });
      }
      if (handlers.onDelete) {
        this.conn.db.active_guest.onDelete((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onDelete!(row.id);
        });
      }
    } catch (e) {
      console.warn("[Cloud] subscribeActiveGuestChanges failed:", e);
    }
  }

  /** Subscribe to live active_ticket changes for the current restaurant.
   * Same deferral as staff: own-restaurant wiring waits for Phase H
   * cutover. Visit mode uses this to show other players' kitchens
   * mid-cooking in real time. */
  subscribeActiveTicketChanges(handlers: {
    onInsert?: (row: ActiveTicketRow) => void;
    onUpdate?: (row: ActiveTicketRow) => void;
    onDelete?: (id: bigint) => void;
  }, restaurantId?: bigint): void {
    if (!this.conn) return;
    const rid = restaurantId ?? this.restaurantId;
    if (rid == null) return;
    type ServerRow = {
      id: bigint; restaurantId: bigint; clientTempId: string; guestId: bigint;
      recipeId: string; state: string; stateClockMs: bigint;
      cookSecondsMs: bigint; assignedChefId: string;
      seatX: number; seatZ: number; seatFloor: number; seatAtBar: boolean;
      pickupX: number; pickupZ: number; pickupFloor: number;
      appliance: string;
    };
    const toClientRow = (r: ServerRow): ActiveTicketRow => ({
      id: r.id, clientTempId: r.clientTempId, guestId: r.guestId,
      recipeId: r.recipeId, state: r.state, stateClockMs: r.stateClockMs,
      cookSeconds: r.cookSecondsMs, assignedChefId: r.assignedChefId,
      seatX: r.seatX, seatZ: r.seatZ, seatFloor: r.seatFloor, seatAtBar: r.seatAtBar,
      pickupX: r.pickupX, pickupZ: r.pickupZ, pickupFloor: r.pickupFloor,
      appliance: r.appliance,
    });
    try {
      if (handlers.onInsert) {
        this.conn.db.active_ticket.onInsert((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onInsert!(toClientRow(row));
        });
      }
      if (handlers.onUpdate) {
        this.conn.db.active_ticket.onUpdate((_ctx, _old: ServerRow, newRow: ServerRow) => {
          if (newRow.restaurantId !== rid) return;
          handlers.onUpdate!(toClientRow(newRow));
        });
      }
      if (handlers.onDelete) {
        this.conn.db.active_ticket.onDelete((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onDelete!(row.id);
        });
      }
    } catch (e) {
      console.warn("[Cloud] subscribeActiveTicketChanges failed:", e);
    }
  }

  registerStaffActor(args: {
    memberId: string;
    role: string;
    homeFloor: number;
    homeX: number;
    homeZ: number;
    spawnX: number;
    spawnZ: number;
    spawnFloor: number;
  }): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.registerStaffActor({
        restaurantId: this.restaurantId,
        memberId: args.memberId,
        role: args.role,
        homeFloor: args.homeFloor,
        homeX: args.homeX,
        homeZ: args.homeZ,
        spawnX: args.spawnX,
        spawnZ: args.spawnZ,
        spawnFloor: args.spawnFloor,
      });
    } catch (e) {
      console.warn("[Cloud] registerStaffActor failed:", e);
    }
  }

  /** One-shot comprehensive update. The caller passes every field; the
   * server stores them. state_clock_ms is reset by the reducer only
   * when the state label flips. */
  updateStaffActor(args: {
    memberId: string;
    state: string;
    ticketId: bigint | null;
    x: number; z: number; floor: number;
    targetX: number; targetZ: number; targetFloor: number;
    assignedStoveUid: string;
    lastStoveUid: string;
    washTargetUid: string;
    washDirtyId: bigint;
    washPhase: string;
    takeOrderGuestId: bigint | null;
  }): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.updateStaffActor({
        memberId: args.memberId,
        state: args.state,
        ticketId: args.ticketId ?? undefined,
        x: args.x, z: args.z, floor: args.floor,
        targetX: args.targetX, targetZ: args.targetZ, targetFloor: args.targetFloor,
        assignedStoveUid: args.assignedStoveUid,
        lastStoveUid: args.lastStoveUid,
        washTargetUid: args.washTargetUid,
        washDirtyId: args.washDirtyId,
        washPhase: args.washPhase,
        takeOrderGuestId: args.takeOrderGuestId ?? undefined,
      });
    } catch (e) {
      console.warn("[Cloud] updateStaffActor failed:", e);
    }
  }

  /** Phase H Phase 5.1+ — Errand-helper trip state mirror. Local
   * ErrandRouter calls on every phase transition + on trip start to
   * stamp the new errand_phase / errand_trip_list_csv /
   * errand_offscreen_until_micros columns on the helper's
   * staff_actor row. Lets visit mode + co-owner views render the
   * errand walk with the right phase context BEFORE the Phase 5.2
   * server detector lands.
   *
   * phase / tripListCsv are nullable to signal "trip done / idle".
   * offscreenUntilMicros is 0 except during the "offscreen"
   * shopping leg. */
  setErrandState(args: {
    memberId: string;
    phase: string | null;
    tripListCsv: string | null;
    offscreenUntilMicros: bigint;
  }): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.setErrandState({
        memberId: args.memberId,
        phase: args.phase ?? undefined,
        tripListCsv: args.tripListCsv ?? undefined,
        offscreenUntilMicros: args.offscreenUntilMicros,
      });
    } catch (e) {
      console.warn("[Cloud] setErrandState failed:", e);
    }
  }

  /** Visit-mode theme parity — push the per-floor theme overrides
   * (DecorModal picks) to the cloud's Restaurant.theme_overrides_csv
   * column. Empty floors fall through to the catalog default; visit
   * mode reads this on entry to render the same wall + slab colors
   * the host picked. Fires from Engine's onThemeChanged hook on every
   * applyTheme. Idempotent: server skips the write when CSV matches. */
  setRestaurantThemeOverrides(themesByFloor: Record<number, string>): void {
    if (!this.conn || this.restaurantId == null) return;
    // Serialize as "storey:theme_id|storey:theme_id". Skip floors that
    // happen to carry the default catalog id — keeps the CSV small.
    const parts: string[] = [];
    for (const [k, id] of Object.entries(themesByFloor)) {
      const floor = Number(k);
      if (!Number.isFinite(floor) || floor < 0) continue;
      if (!id) continue;
      parts.push(`${floor}:${id}`);
    }
    const csv = parts.join("|");
    try {
      this.conn.reducers.setRestaurantThemeOverrides({
        restaurantId: this.restaurantId,
        csv,
      });
    } catch (e) {
      console.warn("[Cloud] setRestaurantThemeOverrides failed:", e);
    }
  }

  /** Visit-mode rating-sign style parity — push the per-player sign
   * style picks (font / textColor / plaqueStyle) to the cloud
   * Restaurant row. Fires from Engine's onRestaurantSignChanged hook
   * on every setRestaurantSign call. Idempotent server-side. */
  /** Phase 6.8 — eager-push the restaurant display name. The legacy
   * autosave path also writes Restaurant.name, but only every few
   * minutes; this reducer covers the gap so visitors see a rename in
   * the door plaque within sub-second. Trimmed + capped to 28 chars
   * server-side; empty falls back to "Cozy Bistro". */
  setRestaurantName(name: string): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.setRestaurantName({
        restaurantId: this.restaurantId,
        name,
      });
    } catch (e) {
      console.warn("[Cloud] setRestaurantName failed:", e);
    }
  }

  setRestaurantSignStyle(style: { font: string; textColor: string; plaqueStyle: string }): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.setRestaurantSignStyle({
        restaurantId: this.restaurantId,
        font: style.font,
        textColor: style.textColor,
        plaqueStyle: style.plaqueStyle,
      });
    } catch (e) {
      console.warn("[Cloud] setRestaurantSignStyle failed:", e);
    }
  }

  /** Visit-mode rating-sign style parity — read the visited
   * restaurant's sign style from the subscribed Restaurant row.
   * Falls back to the catalog default ("serif" / "cream" / "dark")
   * for any unset field. */
  getRestaurantSignStyleByOwnerHex(ownerHex: string): { font: string; textColor: string; plaqueStyle: string } {
    const fallback = { font: "serif", textColor: "cream", plaqueStyle: "dark" };
    if (!this.conn) return fallback;
    const target = ownerHex.toLowerCase();
    try {
      for (const r of this.conn.db.restaurant.iter()) {
        if (r.owner.toHexString().toLowerCase() !== target) continue;
        return {
          font: r.signFont ?? fallback.font,
          textColor: r.signTextColor ?? fallback.textColor,
          plaqueStyle: r.signPlaqueStyle ?? fallback.plaqueStyle,
        };
      }
    } catch { /* table not wired yet */ }
    return fallback;
  }

  /** Visit-mode rating-sign rating parity — compute the visited
   * restaurant's average star rating from the same cloud_rating_history
   * CSV the host already pushes via setCloudRatingHistory. Returns 0
   * when no history exists. Cap at 1..5 with round-half-up. */
  getRestaurantRatingByOwnerHex(ownerHex: string): number {
    if (!this.conn) return 0;
    const target = ownerHex.toLowerCase();
    try {
      for (const r of this.conn.db.restaurant.iter()) {
        if (r.owner.toHexString().toLowerCase() !== target) continue;
        const csv = r.cloudRatingHistoryCsv ?? "";
        if (!csv) return 0;
        const values = csv.split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n));
        if (values.length === 0) return 0;
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        return avg;
      }
    } catch { /* table not wired yet */ }
    return 0;
  }

  unregisterStaffActor(memberId: string): void {
    if (!this.conn) return;
    try { this.conn.reducers.unregisterStaffActor({ memberId }); }
    catch (e) { console.warn("[Cloud] unregisterStaffActor failed:", e); }
  }

  // =====================================================================
  //                Phase F — placed_furniture helpers
  // =====================================================================
  // Three thin wrappers around place / move / sell. The client owns
  // uids directly (no client_temp_id correlation needed) — same
  // pattern as staff_actor.member_id.

  listPlacedFurniture(): PlacedFurnitureRow[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: PlacedFurnitureRow[] = [];
    const rid = this.restaurantId;
    try {
      for (const f of this.conn.db.placed_furniture.iter()) {
        if (f.restaurantId !== rid) continue;
        out.push({
          uid: f.uid,
          defId: f.defId,
          x: f.x, z: f.z, rotY: f.rotY, floor: f.floor,
          parentUid: f.parentUid,
          slotIndex: f.slotIndex,
          localRotY: f.localRotY,
        });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Phase M.5 — placed_furniture for a VISITED restaurant (by owner hex),
   * so Visit Mode renders the host's CURRENT server furniture instead of a
   * stale save snapshot. This is the SAME source the host's guests are
   * seated from (placed_furniture → seat_slot), so chairs and seated guests
   * always align — no more "invisible chairs" when the host rearranged since
   * their last save publish. Returns [] if the owner's restaurant or its
   * furniture rows aren't in the subscription yet (caller falls back to the
   * save blob). */
  listPlacedFurnitureByOwnerHex(ownerHex: string): PlacedFurnitureRow[] {
    if (!this.conn) return [];
    const target = ownerHex.toLowerCase();
    let rid: bigint | null = null;
    try {
      for (const r of this.conn.db.restaurant.iter()) {
        if (r.owner.toHexString().toLowerCase() === target) { rid = r.id; break; }
      }
    } catch { /* restaurant table not wired */ }
    if (rid == null) return [];
    const out: PlacedFurnitureRow[] = [];
    try {
      for (const f of this.conn.db.placed_furniture.iter()) {
        if (f.restaurantId !== rid) continue;
        out.push({
          uid: f.uid,
          defId: f.defId,
          x: f.x, z: f.z, rotY: f.rotY, floor: f.floor,
          parentUid: f.parentUid,
          slotIndex: f.slotIndex,
          localRotY: f.localRotY,
        });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  placeFurniture(args: {
    uid: string;
    defId: string;
    x: number; z: number; rotY: number; floor: number;
    parentUid: string;
    slotIndex: number;
    localRotY: number;
  }): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.placeFurniture({
        restaurantId: this.restaurantId,
        uid: args.uid,
        defId: args.defId,
        x: args.x, z: args.z, rotY: args.rotY, floor: args.floor,
        parentUid: args.parentUid,
        slotIndex: args.slotIndex,
        localRotY: args.localRotY,
      });
    } catch (e) {
      console.warn("[Cloud] placeFurniture failed:", e);
    }
  }

  moveFurniture(args: {
    uid: string;
    x: number; z: number; rotY: number; floor: number;
    parentUid: string;
    slotIndex: number;
    localRotY: number;
  }): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.moveFurniture(args);
    } catch (e) {
      console.warn("[Cloud] moveFurniture failed:", e);
    }
  }

  sellFurniture(uid: string): void {
    if (!this.conn) return;
    try { this.conn.reducers.sellFurniture({ uid }); }
    catch (e) { console.warn("[Cloud] sellFurniture failed:", e); }
  }

  /** QoL storage — bank a placed item into the storage room (no refund)
   * instead of selling it. Server deletes the row + increments the
   * furniture_inventory qty for its def. */
  storeFurniture(uid: string): void {
    if (!this.conn) return;
    try { this.conn.reducers.storeFurniture({ uid }); }
    catch (e) { console.warn("[Cloud] storeFurniture failed:", e); }
  }

  /** QoL storage — re-place a stored item for FREE (no money debit). The
   * server decrements the inventory qty + inserts the placed_furniture
   * row. Same arg shape as placeFurniture so the registry reuses its
   * normal placement bookkeeping; it just calls this on the storage path. */
  placeFromInventory(args: {
    uid: string;
    defId: string;
    x: number; z: number; rotY: number; floor: number;
    parentUid: string;
    slotIndex: number;
    localRotY: number;
  }): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.placeFromInventory({
        restaurantId: this.restaurantId,
        uid: args.uid,
        defId: args.defId,
        x: args.x, z: args.z, rotY: args.rotY, floor: args.floor,
        parentUid: args.parentUid,
        slotIndex: args.slotIndex,
        localRotY: args.localRotY,
      });
    } catch (e) {
      console.warn("[Cloud] placeFromInventory failed:", e);
    }
  }

  /** Owned-but-unplaced furniture (the storage room) for the current
   * restaurant, as {defId, qty} with qty > 0. */
  listFurnitureInventory(): { defId: string; qty: number }[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: { defId: string; qty: number }[] = [];
    const rid = this.restaurantId;
    try {
      for (const i of this.conn.db.furniture_inventory.iter()) {
        if (i.restaurantId !== rid) continue;
        if (i.qty > 0) out.push({ defId: i.defId, qty: i.qty });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Fire `onChange` whenever this restaurant's storage inventory changes
   * (store / re-place), so the build menu's storage list stays live. */
  subscribeFurnitureInventoryChanges(onChange: () => void): void {
    if (!this.conn || this.restaurantId == null) return;
    const rid = this.restaurantId;
    type InvRow = { id: string; restaurantId: bigint; defId: string; qty: number };
    const fire = (r: InvRow): void => { if (r.restaurantId === rid) onChange(); };
    try {
      this.conn.db.furniture_inventory.onInsert((_c, r: InvRow) => fire(r));
      this.conn.db.furniture_inventory.onUpdate((_c, _o: InvRow, n: InvRow) => fire(n));
      this.conn.db.furniture_inventory.onDelete((_c, r: InvRow) => fire(r));
    } catch (e) {
      console.warn("[Cloud] subscribeFurnitureInventoryChanges failed:", e);
    }
  }

  /** QoL layout — save/overwrite a named preset = serialized layout JSON. */
  saveLayoutPreset(name: string, layoutJson: string): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.saveLayoutPreset({ restaurantId: this.restaurantId, name, layoutJson });
    } catch (e) { console.warn("[Cloud] saveLayoutPreset failed:", e); }
  }

  /** QoL layout — delete a named preset. */
  deleteLayoutPreset(name: string): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.deleteLayoutPreset({ restaurantId: this.restaurantId, name });
    } catch (e) { console.warn("[Cloud] deleteLayoutPreset failed:", e); }
  }

  /** QoL layout — named layout presets for this restaurant. */
  listLayoutPresets(): { name: string; layoutJson: string }[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: { name: string; layoutJson: string }[] = [];
    const rid = this.restaurantId;
    try {
      for (const p of this.conn.db.layout_preset.iter()) {
        if (p.restaurantId !== rid) continue;
        out.push({ name: p.name, layoutJson: p.layoutJson });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Fire `onChange` whenever this restaurant's layout presets change. */
  subscribeLayoutPresetChanges(onChange: () => void): void {
    if (!this.conn || this.restaurantId == null) return;
    const rid = this.restaurantId;
    type LpRow = { id: string; restaurantId: bigint; name: string; layoutJson: string };
    const fire = (r: LpRow): void => { if (r.restaurantId === rid) onChange(); };
    try {
      this.conn.db.layout_preset.onInsert((_c, r: LpRow) => fire(r));
      this.conn.db.layout_preset.onUpdate((_c, _o: LpRow, n: LpRow) => fire(n));
      this.conn.db.layout_preset.onDelete((_c, r: LpRow) => fire(r));
    } catch (e) {
      console.warn("[Cloud] subscribeLayoutPresetChanges failed:", e);
    }
  }

  /** Subscribe to live placed_furniture row changes for the current
   * restaurant. Used by FurnitureRegistry to apply other clients'
   * edits without a refresh. The three callbacks fire for the
   * matching SDK events; the wrapper filters out rows that aren't
   * mine (the subscription cache returns rows from every restaurant
   * the module hosts, but we only render our own here).
   *
   * Caller is responsible for the "did I already apply this locally"
   * check — same row data flows through after our OWN reducer call,
   * so naive subscribers would double-apply.
   *
   * No unsubscribe yet — the listeners persist for the session. Add
   * if we ever need to flip the flag mid-session. */
  subscribePlacedFurnitureChanges(handlers: {
    onInsert?: (row: PlacedFurnitureRow) => void;
    onUpdate?: (row: PlacedFurnitureRow) => void;
    onDelete?: (uid: string) => void;
  }, restaurantId?: bigint): void {
    if (!this.conn) return;
    const rid = restaurantId ?? this.restaurantId;
    if (rid == null) return;
    type ServerRow = { uid: string; defId: string; restaurantId: bigint;
        x: number; z: number; rotY: number; floor: number;
        parentUid: string; slotIndex: number; localRotY: number };
    const toClientRow = (r: ServerRow): PlacedFurnitureRow => ({
      uid: r.uid, defId: r.defId,
      x: r.x, z: r.z, rotY: r.rotY, floor: r.floor,
      parentUid: r.parentUid, slotIndex: r.slotIndex, localRotY: r.localRotY,
    });
    try {
      if (handlers.onInsert) {
        this.conn.db.placed_furniture.onInsert((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onInsert!(toClientRow(row));
        });
      }
      if (handlers.onUpdate) {
        this.conn.db.placed_furniture.onUpdate((_ctx, _oldRow: ServerRow, newRow: ServerRow) => {
          if (newRow.restaurantId !== rid) return;
          handlers.onUpdate!(toClientRow(newRow));
        });
      }
      if (handlers.onDelete) {
        this.conn.db.placed_furniture.onDelete((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onDelete!(row.uid);
        });
      }
    } catch (e) {
      console.warn("[Cloud] subscribePlacedFurnitureChanges failed:", e);
    }
  }

  // =====================================================================
  //                Phase E — dishware helpers
  // =====================================================================

  /** Upsert one (kind, tier) pool entry. Server deletes the row when
   * clean + dirty are both zero so empty pools don't accumulate. */
  updateDishwarePool(kind: "plate" | "glass", tier: number, clean: number, dirty: number): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.updateDishwarePool({
        restaurantId: this.restaurantId,
        kind, tier, clean, dirty,
      });
    } catch (e) {
      console.warn("[Cloud] updateDishwarePool failed:", e);
    }
  }

  /** H.39 — Mirror a hired-staff roster entry to the cloud.  Called
   * from StaffSystem.addStaff at hire time AND from training
   * completion (upgrade_level change).  Idempotent server-side. */
  setHiredStaffMember(args: {
    memberId: string;
    role: string;
    name: string;
    upgradeLevel: number;
    isDeactivated?: boolean;
  }): void {
    if (!this.conn || this.restaurantId == null) return;
    if (!args.memberId) return;
    try {
      this.conn.reducers.setHiredStaffMember({
        restaurantId: this.restaurantId,
        memberId: args.memberId,
        role: args.role,
        name: args.name,
        upgradeLevel: Math.max(0, Math.round(args.upgradeLevel)),
        isDeactivated: args.isDeactivated ?? false,
      });
    } catch (e) {
      console.warn("[Cloud] setHiredStaffMember failed:", e);
    }
  }

  /** H.39 — Drop a hired-staff roster row.  Called from
   * StaffSystem.removeStaff / removeStaffById at fire time. */
  deleteHiredStaffMember(memberId: string): void {
    if (!this.conn) return;
    if (!memberId) return;
    try {
      this.conn.reducers.deleteHiredStaffMember({ memberId });
    } catch (e) {
      console.warn("[Cloud] deleteHiredStaffMember failed:", e);
    }
  }

  /** H.40 — Seed full per-recipe metadata. Sibling to
   * setRecipeIngredients (which is just the ingredient list);
   * carries cook-time / appliance / pricing / satisfaction / category
   * so the server's build_server_order can construct orders for
   * backgrounded-only guests (server-spawned via H.33 with no
   * foreground client to call buildOrder + set_guest_order). */
  setRecipeMeta(args: {
    recipeId: string;
    baseCookSecondsMs: number;
    appliance: string;
    sellPriceCents: number;
    satisfactionX100Base: number;
    category: string;
    /** H.53 — luxury tier (1-5).  Server uses tier × upgrade-level
     * to compute the price bonus.  Defaults to 1 in callers that
     * pre-date this field. */
    tier: number;
  }): void {
    if (!this.conn) return;
    if (!args.recipeId) return;
    try {
      this.conn.reducers.setRecipeMeta({
        recipeId: args.recipeId,
        baseCookSecondsMs: BigInt(Math.max(0, Math.round(args.baseCookSecondsMs))),
        appliance: args.appliance,
        sellPriceCents: BigInt(Math.max(0, Math.round(args.sellPriceCents))),
        satisfactionX100Base: Math.max(0, Math.round(args.satisfactionX100Base)),
        category: args.category,
        tier: Math.max(1, Math.min(5, Math.round(args.tier))),
      });
    } catch (e) {
      console.warn("[Cloud] setRecipeMeta failed:", e);
    }
  }

  /** H.53 — Mirror the per-restaurant upgrade level for a recipe.
   * Owner-only server-side.  Server's build_server_order looks
   * this up to apply effective-price + effective-satisfaction
   * bonuses to server-spawned guests' orders. */
  setRecipeLevel(recipeId: string, level: number): void {
    if (!this.conn || this.restaurantId == null) return;
    if (!recipeId) return;
    try {
      this.conn.reducers.setRecipeLevel({
        restaurantId: this.restaurantId,
        recipeId,
        level: Math.max(1, Math.round(level)),
      });
    } catch (e) {
      console.warn("[Cloud] setRecipeLevel failed:", e);
    }
  }

  /** H.40 — Mirror the active menu so the server's order builder
   * knows which recipes are available for backgrounded guests to
   * order. Called whenever CookingSystem changes the menu set. */
  setActiveMenu(recipeIds: readonly string[]): void {
    const csv = recipeIds.join(",");
    // New-account boot: the restaurant resolves lazily / after subscription,
    // so this seed can fire before restaurantId is known. Stash it and flush
    // when the id resolves (flushPendingActiveMenu) — otherwise the default
    // menu never reaches the server and guests can never order (chef idle).
    if (!this.conn || this.restaurantId == null) {
      this.pendingActiveMenuCsv = csv;
      return;
    }
    try {
      this.conn.reducers.setActiveMenu({
        restaurantId: this.restaurantId,
        recipeIds: csv,
      });
      this.pendingActiveMenuCsv = null;
    } catch (e) {
      console.warn("[Cloud] setActiveMenu failed:", e);
    }
  }

  /** H.38 — Seed one row of the customer_archetype catalog.  Same
   * shape as setRecipeIngredients: idempotent server-side, fire-and-
   * forget, called once per archetype at boot.  Server's H.33
   * pedestrian → guest spawn reads this to pick weighted archetype
   * + apply the patience multiplier and WC-use roll instead of
   * hardcoding "regular" with neutral defaults. */
  setCustomerArchetype(args: {
    archetypeId: string;
    weight: number;
    patienceMultX100: number;
    tipMultX100: number;
    orderSizeBias: number;
    wcUseChanceX100: number;
  }): void {
    if (!this.conn) return;
    if (!args.archetypeId) return;
    try {
      this.conn.reducers.setCustomerArchetype({
        archetypeId: args.archetypeId,
        weight: Math.max(0, Math.round(args.weight)),
        patienceMultX100: Math.round(args.patienceMultX100),
        tipMultX100: Math.round(args.tipMultX100),
        orderSizeBias: Math.round(args.orderSizeBias),
        wcUseChanceX100: Math.round(args.wcUseChanceX100),
      });
    } catch (e) {
      console.warn("[Cloud] setCustomerArchetype failed:", e);
    }
  }

  /** H.37 — Seed one row of the recipe_ingredients lookup table.
   * Called once per recipe at boot; idempotent server-side so
   * repeat-on-reconnect is fine. Empty `ingredients` is allowed for
   * catalog-edge-case recipes.  Fire-and-forget — server-side
   * consumption silently no-ops on unseeded recipes, so a delayed
   * seed doesn't break gameplay. */
  setRecipeIngredients(recipeId: string, ingredients: string[]): void {
    if (!this.conn) return;
    if (!recipeId) return;
    try {
      this.conn.reducers.setRecipeIngredients({
        recipeId,
        ingredients: ingredients.join("|"),
      });
    } catch (e) {
      console.warn("[Cloud] setRecipeIngredients failed:", e);
    }
  }

  /** H.36 — Delta-based mirror for pantry stock. CookingSystem fires
   * this on every consumeIngredients (-1 per ingredient slot) and
   * addPantryStock (+qty per slot). Server saturating-adds to a row
   * keyed on (restaurant_id, ingredient_id); rows are deleted when
   * quantity hits 0.
   *
   * Server-side consumption on backgrounded ticket cooks (the actual
   * "stop cheating" fix) ships in a follow-up — H.37 adds a recipe
   * → ingredient lookup so auto_claim_queued_tickets can decrement
   * autonomously. */
  /** Phase I.1 (H.48d) — Snapshot every pantry_stock row for this
   * restaurant.  Used by CookingSystem.restorePantryFromCloud on
   * connect so local pantry counts match server reality (server may
   * have consumed ingredients via H.37 + restocked via H.41 during
   * the offline window).  Returns empty when not connected. */
  listPantryStock(): { ingredientId: string; quantity: number }[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: { ingredientId: string; quantity: number }[] = [];
    const rid = this.restaurantId;
    try {
      for (const p of this.conn.db.pantry_stock.iter()) {
        if (p.restaurantId !== rid) continue;
        out.push({ ingredientId: p.ingredientId, quantity: p.quantity });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  bumpPantryStock(ingredientId: string, delta: number): void {
    if (!this.conn || this.restaurantId == null) return;
    if (delta === 0 || !ingredientId) return;
    try {
      this.conn.reducers.bumpPantryStock({
        restaurantId: this.restaurantId,
        ingredientId,
        delta: Math.round(delta),
      });
    } catch (e) {
      console.warn("[Cloud] bumpPantryStock failed:", e);
    }
  }

  /** Path B — Prepared-servings mirror. Upsert the count of
   * cook-ahead dishes sitting on the pass for one recipe; the server
   * deletes the row at count 0. Fired from CookingSystem's
   * mirrorPreparedServing on every preparedServings mutation.
   * Idempotent server-side on identical counts. */
  setPreparedServing(recipeId: string, count: number): void {
    if (!this.conn || this.restaurantId == null) return;
    if (!recipeId) return;
    try {
      this.conn.reducers.setPreparedServing({
        restaurantId: this.restaurantId,
        recipeId,
        count: Math.max(0, Math.round(count)),
      });
    } catch (e) {
      console.warn("[Cloud] setPreparedServing failed:", e);
    }
  }

  /** Path B — Prepared-servings read side: every prepared_serving
   * row for this restaurant. The Engine boot retry loop feeds these
   * to CookingSystem.restorePreparedServingsFromCloud (cloud wins
   * wholesale, same one-shot shape as the recipe-upgrade deadlines). */
  listPreparedServings(): { recipeId: string; count: number }[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: { recipeId: string; count: number }[] = [];
    const rid = this.restaurantId;
    try {
      for (const p of this.conn.db.prepared_serving.iter()) {
        if (p.restaurantId !== rid) continue;
        out.push({ recipeId: p.recipeId, count: p.count });
      }
    } catch { /* table not wired pre-publish */ }
    return out;
  }

  /** SELL-BACK — Sell up to `units` of one pantry ingredient back at
   * 50% of the seeded ingredient_cost catalog price. The server clamps
   * to the current pantry_stock quantity, decrements the row (keeping
   * it at 0 per Phase 7.3), and credits the refund to cloud_money_cents
   * — the Phase 7.7 restaurant.onUpdate delta-sync adopts the credit
   * locally, so callers must NOT earn money client-side. */
  sellPantryStock(ingredientId: string, units: number): void {
    if (!this.conn || this.restaurantId == null) return;
    if (!ingredientId || units <= 0) return;
    try {
      this.conn.reducers.sellPantryStock({
        restaurantId: this.restaurantId,
        ingredientId,
        units: Math.round(units),
      });
    } catch (e) {
      console.warn("[Cloud] sellPantryStock failed:", e);
    }
  }

  /** H.41 — Seed one row of the ingredient_cost catalog at boot.  Mirrors
   * INGREDIENT_COSTS in src/data/ingredients.ts.  Server uses these to
   * bill auto-shop restocks to Restaurant.pending_restock_cost_cents
   * when a backgrounded ticket places into an empty pantry slot.
   * Idempotent server-side. */
  setIngredientCost(ingredientId: string, costCents: number): void {
    if (!this.conn) return;
    if (!ingredientId) return;
    if (!Number.isFinite(costCents) || costCents < 0) return;
    try {
      this.conn.reducers.setIngredientCost({
        ingredientId,
        costCents: BigInt(Math.round(costCents)),
      });
    } catch (e) {
      console.warn("[Cloud] setIngredientCost failed:", e);
    }
  }

  /** Phase A2 (anti-cheat) — seed one furniture def's scaled cost (cents)
   * so the validated place_furniture reducer can price-check a purchase.
   * Idempotent server-side; a CHANGE is admin-only. */
  setFurnitureCost(defId: string, costCents: number, refundCents: number): void {
    if (!this.conn) return;
    if (!defId) return;
    if (!Number.isFinite(costCents) || costCents < 0) return;
    if (!Number.isFinite(refundCents) || refundCents < 0) return;
    try {
      this.conn.reducers.setFurnitureCost({
        defId,
        costCents: BigInt(Math.round(costCents)),
        refundCents: BigInt(Math.round(refundCents)),
      });
    } catch (e) {
      console.warn("[Cloud] setFurnitureCost failed:", e);
    }
  }

  /** Phase 9.62 — seed one furniture def's metadata (category + stats +
   * serving surface) so the SERVER computes per-seat taste appeal + the
   * attraction aggregate itself. Idempotent server-side; a CHANGE is
   * admin-only (same gate as setFurnitureCost). */
  setFurnitureMeta(
    defId: string,
    category: string,
    styleX100: number,
    comfortX100: number,
    attractionX100: number,
    ratingBonusX100: number,
    surface: string,
  ): void {
    if (!this.conn) return;
    if (!defId) return;
    try {
      this.conn.reducers.setFurnitureMeta({
        defId,
        category,
        styleX100: Math.round(styleX100),
        comfortX100: Math.round(comfortX100),
        attractionX100: Math.round(attractionX100),
        ratingBonusX100: Math.round(ratingBonusX100),
        surface,
      });
    } catch (e) {
      console.warn("[Cloud] setFurnitureMeta failed:", e);
    }
  }

  /** H.41 — Read the restaurant's accrued auto-shop debt.  Caller is
   * Engine.onSubscriptionReady; returns cents that should be debited
   * via game.economy.forceSpendMoney("restock") before firing
   * consumePendingRestockCost to clear it.  Returns 0 if no row
   * (pre-migration restaurant, or already drained). */
  getPendingRestockCostCents(): number {
    if (!this.conn || this.restaurantId == null) return 0;
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row) return 0;
      const v = row.pendingRestockCostCents;
      if (v == null) return 0;
      // SDK returns BigInt for i64; coerce to Number (safe: cents up
      // to 2^53 == $90 trillion).
      return typeof v === "bigint" ? Number(v) : Number(v);
    } catch (e) {
      console.warn("[Cloud] getPendingRestockCostCents failed:", e);
      return 0;
    }
  }

  /** H.41 — Owner-only.  Clear pending_restock_cost_cents to zero
   * AFTER the client has debited the player's local money via
   * forceSpendMoney("restock").  Idempotent: zero counter is a
   * silent server-side no-op. */
  consumePendingRestockCost(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.consumePendingRestockCost({
        restaurantId: this.restaurantId,
      });
    } catch (e) {
      console.warn("[Cloud] consumePendingRestockCost failed:", e);
    }
  }

  // ===== H.43 — Server-side recipe upgrade timers =====

  /** H.43 — Mirror startRecipeUpgrade to the server so it can fire
   * the level-up completion even while this tab is closed.  The
   * server holds the deadline in recipe_upgrade_in_flight; when it
   * passes, the recipe_id is appended to
   * Restaurant.pending_recipe_upgrades_completed_csv for this client
   * to drain on reconnect. */
  startRecipeUpgrade(recipeId: string, completesAtEpochMs: number): void {
    if (!this.conn || this.restaurantId == null) return;
    if (!recipeId) return;
    if (!Number.isFinite(completesAtEpochMs) || completesAtEpochMs <= 0) return;
    try {
      this.conn.reducers.startRecipeUpgrade({
        restaurantId: this.restaurantId,
        recipeId,
        // Server stores in micros (Unix epoch); ms → μs.
        completesAtMicros: BigInt(Math.round(completesAtEpochMs * 1000)),
      });
    } catch (e) {
      console.warn("[Cloud] startRecipeUpgrade failed:", e);
    }
  }

  /** H.43 — Mirror cancelRecipeUpgrade to the server. Server drops
   * the in-flight row; no completion is fired. */
  cancelRecipeUpgrade(recipeId: string): void {
    if (!this.conn || this.restaurantId == null) return;
    if (!recipeId) return;
    try {
      this.conn.reducers.cancelRecipeUpgrade({
        restaurantId: this.restaurantId,
        recipeId,
      });
    } catch (e) {
      console.warn("[Cloud] cancelRecipeUpgrade failed:", e);
    }
  }

  /** H.43 — Read the comma-separated list of recipe_ids the server
   * leveled-up while this tab was offline.  Empty array if none.
   * Caller applies level+1 to local state, then fires
   * consumePendingRecipeUpgrades to clear. */
  getPendingRecipeUpgradesCompleted(): string[] {
    if (!this.conn || this.restaurantId == null) return [];
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row) return [];
      const csv = row.pendingRecipeUpgradesCompletedCsv ?? "";
      if (!csv) return [];
      return csv.split(",").filter((s) => s.length > 0);
    } catch (e) {
      console.warn("[Cloud] getPendingRecipeUpgradesCompleted failed:", e);
      return [];
    }
  }

  /** H.43 — Owner-only.  Clear the pending CSV after draining. */
  consumePendingRecipeUpgrades(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.consumePendingRecipeUpgrades({
        restaurantId: this.restaurantId,
      });
    } catch (e) {
      console.warn("[Cloud] consumePendingRecipeUpgrades failed:", e);
    }
  }

  // ===== H.44 — Server-side staff training timers =====

  /** H.44 — Mirror startMemberTraining / cancelMemberTraining.
   * Pass 0 to cancel (matches the server convention). */
  setMemberTrainingDeadline(memberId: string, completesAtEpochMs: number): void {
    if (!this.conn) return;
    if (!memberId) return;
    if (!Number.isFinite(completesAtEpochMs) || completesAtEpochMs < 0) return;
    try {
      this.conn.reducers.setMemberTrainingDeadline({
        memberId,
        completesAtMicros: BigInt(Math.round(completesAtEpochMs * 1000)),
      });
    } catch (e) {
      console.warn("[Cloud] setMemberTrainingDeadline failed:", e);
    }
  }

  /** H.44 — Read the comma-separated list of member_ids the server
   * leveled-up while this tab was offline.  The cloud's
   * hired_staff_member.upgrade_level is already authoritative;
   * caller uses this list to know whose level-up to toast. */
  getPendingTrainingCompletions(): string[] {
    if (!this.conn || this.restaurantId == null) return [];
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row) return [];
      const csv = row.pendingTrainingCompletionsCsv ?? "";
      if (!csv) return [];
      return csv.split(",").filter((s) => s.length > 0);
    } catch (e) {
      console.warn("[Cloud] getPendingTrainingCompletions failed:", e);
      return [];
    }
  }

  /** H.44 — Owner-only.  Clear the pending CSV after draining. */
  consumePendingTrainingCompletions(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.consumePendingTrainingCompletions({
        restaurantId: this.restaurantId,
      });
    } catch (e) {
      console.warn("[Cloud] consumePendingTrainingCompletions failed:", e);
    }
  }

  /** H.44 — Lookup the cloud-mirrored upgrade_level for a given
   * member_id.  Used on reconnect to sync local roster levels to
   * whatever the server has (catches members whose level was bumped
   * during the offline period). Returns null if no row exists. */
  getCloudMemberUpgradeLevel(memberId: string): number | null {
    if (!this.conn) return null;
    try {
      const row = this.conn.db.hired_staff_member.member_id.find(memberId);
      if (!row) return null;
      return row.upgradeLevel;
    } catch (e) {
      console.warn("[Cloud] getCloudMemberUpgradeLevel failed:", e);
      return null;
    }
  }

  // ===== H.45 — Server-side offline salary accrual =====

  /** H.45 — Mirror the base payroll rate (dollars/min/staff →
   * cents/min/staff).  Server uses this + the hired_staff_member
   * roster to compute offline salary accruals.  Fires on boot +
   * whenever the rate could have changed (admin panel toggle). */
  setCloudPayrollRate(centsPerMinPerStaff: number): void {
    if (!this.conn || this.restaurantId == null) return;
    if (!Number.isFinite(centsPerMinPerStaff) || centsPerMinPerStaff < 0) return;
    try {
      this.conn.reducers.setCloudPayrollRate({
        restaurantId: this.restaurantId,
        centsPerMinPerStaff: BigInt(Math.round(centsPerMinPerStaff)),
      });
    } catch (e) {
      console.warn("[Cloud] setCloudPayrollRate failed:", e);
    }
  }

  /** H.45 — Fire on connect to tell the server "I'm online; don't
   * accrue offline salary for this period."  Server zeros
   * last_salary_tick_micros; the next time the owner goes offline,
   * accrual resumes from that point. */
  resetSalaryTickClock(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.resetSalaryTickClock({
        restaurantId: this.restaurantId,
      });
    } catch (e) {
      console.warn("[Cloud] resetSalaryTickClock failed:", e);
    }
  }

  /** H.45 — Read the accrued offline salary cost (cents). Caller
   * debits the player via forceSpendMoney("salary"), then fires
   * consumePendingSalary to clear. */
  getPendingSalaryCents(): number {
    if (!this.conn || this.restaurantId == null) return 0;
    try {
      const row = this.conn.db.restaurant.id.find(this.restaurantId);
      if (!row) return 0;
      const v = row.pendingSalaryCostCents;
      if (v == null) return 0;
      return typeof v === "bigint" ? Number(v) : Number(v);
    } catch (e) {
      console.warn("[Cloud] getPendingSalaryCents failed:", e);
      return 0;
    }
  }

  /** H.45 — Owner-only.  Clear pending_salary_cost_cents +
   * pending_salary_remainder_x after debiting locally. */
  consumePendingSalary(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.consumePendingSalary({
        restaurantId: this.restaurantId,
      });
    } catch (e) {
      console.warn("[Cloud] consumePendingSalary failed:", e);
    }
  }

  /** H.31 — Delta-based dishware mirror. Each Game.dishware mutation
   * (reserveOne / markDirty / washOne / addClean) pushes its
   * per-operation delta so the server's H.21 wash loader can
   * additively contribute without being clobbered by the next absolute
   * mirror tick. Negative deltas decrement; saturating math on the
   * server prevents underflow.
   *
   * For bulk-sync paths (hydrate after save load, admin reset)
   * updateDishwarePool's absolute push is still correct — those
   * replace state wholesale rather than mutate. */
  bumpDishwarePool(
    kind: "plate" | "glass",
    tier: number,
    cleanDelta: number,
    dirtyDelta: number,
  ): void {
    if (!this.conn || this.restaurantId == null) return;
    if (cleanDelta === 0 && dirtyDelta === 0) return;
    try {
      this.conn.reducers.bumpDishwarePool({
        restaurantId: this.restaurantId,
        kind,
        tier,
        cleanDelta: Math.round(cleanDelta),
        dirtyDelta: Math.round(dirtyDelta),
      });
    } catch (e) {
      console.warn("[Cloud] bumpDishwarePool failed:", e);
    }
  }

  /** SELL-BACK — Sell `count` CLEAN pieces of one (kind, tier) pool
   * back at 50% of `unitPriceCents` (priced client-side from
   * src/data/dishwareCatalog.ts — the server has no dish price table;
   * owner-gating covers it). The server clamps to the row's clean
   * count, decrements through its pool mutator, and credits the
   * refund to cloud_money_cents (adopted locally by the Phase 7.7
   * delta-sync). Callers must NOT mutate the local DishwareSystem
   * pool: every local pool delta auto-mirrors up via bumpDishwarePool,
   * which would double-deduct — the dishware_pool subscription applies
   * the server's decrement instead. */
  sellDishware(
    kind: "plate" | "glass",
    tier: number,
    count: number,
    unitPriceCents: number,
  ): void {
    if (!this.conn || this.restaurantId == null) return;
    if (count <= 0) return;
    try {
      this.conn.reducers.sellDishware({
        restaurantId: this.restaurantId,
        kind,
        tier,
        count: Math.round(count),
        unitPriceCents: BigInt(Math.max(0, Math.round(unitPriceCents))),
      });
    } catch (e) {
      console.warn("[Cloud] sellDishware failed:", e);
    }
  }

  /** Read every dishware_pool row for the current restaurant. Used by
   * DishwareSystem.restoreFromCloud on auth. Returns an empty list if
   * the cloud isn't wired yet. */
  listDishwarePools(): DishwarePoolRow[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: DishwarePoolRow[] = [];
    const rid = this.restaurantId;
    try {
      for (const p of this.conn.db.dishware_pool.iter()) {
        if (p.restaurantId !== rid) continue;
        const kind = p.kind as "plate" | "glass";
        if (kind !== "plate" && kind !== "glass") continue;
        out.push({ kind, tier: p.tier, clean: p.clean, dirty: p.dirty });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Read every dishwasher_batch row for the current restaurant.
   * One row per placed dishwasher currently mid-cycle. */
  listDishwasherBatches(): DishwasherBatchRow[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: DishwasherBatchRow[] = [];
    const rid = this.restaurantId;
    try {
      for (const b of this.conn.db.dishwasher_batch.iter()) {
        if (b.restaurantId !== rid) continue;
        out.push({
          furnitureUid: b.furnitureUid,
          defId: b.defId,
          plates: b.plates,
          glasses: b.glasses,
          cycleTimeRemainingMs: b.cycleTimeRemainingMs,
          // H.93 — server field is Option<String>; the generated SDK
          // surfaces null/undefined for None. Empty string at the
          // call site means "no tier info, fall back to legacy pick".
          platesTiers: (b as { platesTiers?: string | null }).platesTiers ?? "",
          glassesTiers: (b as { glassesTiers?: string | null }).glassesTiers ?? "",
        });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Subscribe to live dishware_pool changes for the current restaurant.
   * DishwareSystem consumes these for cross-device sync of plate /
   * glass counts. Same restaurant-id filter pattern as the furniture
   * subscription — server-side cache surfaces every restaurant's rows
   * and we only want our own.
   *
   * Caller is responsible for the "did I already apply this locally"
   * check — own-write echoes flow through after our OWN reducer call. */
  subscribeDishwarePoolChanges(handlers: {
    onInsert?: (row: DishwarePoolRow) => void;
    onUpdate?: (row: DishwarePoolRow) => void;
    /** No row for delete events — server only provides the key the
     * SDK saw, which is the composite "kind#tier#restaurant" string.
     * We surface the kind + tier so the local pool can be cleared. */
    onDelete?: (kind: "plate" | "glass", tier: number) => void;
  }, restaurantId?: bigint): void {
    if (!this.conn) return;
    const rid = restaurantId ?? this.restaurantId;
    if (rid == null) return;
    type ServerRow = { key: string; restaurantId: bigint; kind: string; tier: number; clean: number; dirty: number };
    const toClientRow = (r: ServerRow): DishwarePoolRow | null => {
      const kind = r.kind as "plate" | "glass";
      if (kind !== "plate" && kind !== "glass") return null;
      return { kind, tier: r.tier, clean: r.clean, dirty: r.dirty };
    };
    try {
      if (handlers.onInsert) {
        this.conn.db.dishware_pool.onInsert((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          const r = toClientRow(row);
          if (r) handlers.onInsert!(r);
        });
      }
      if (handlers.onUpdate) {
        this.conn.db.dishware_pool.onUpdate((_ctx, _old: ServerRow, newRow: ServerRow) => {
          if (newRow.restaurantId !== rid) return;
          const r = toClientRow(newRow);
          if (r) handlers.onUpdate!(r);
        });
      }
      if (handlers.onDelete) {
        this.conn.db.dishware_pool.onDelete((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          const kind = row.kind as "plate" | "glass";
          if (kind !== "plate" && kind !== "glass") return;
          handlers.onDelete!(kind, row.tier);
        });
      }
    } catch (e) {
      console.warn("[Cloud] subscribeDishwarePoolChanges failed:", e);
    }
  }

  /** Subscribe to live dishwasher_batch changes for the current
   * restaurant. Lets a second device watch a wash cycle tick down
   * even when its local sim isn't driving the clock. */
  subscribeDishwasherBatchChanges(handlers: {
    onInsert?: (row: DishwasherBatchRow) => void;
    onUpdate?: (row: DishwasherBatchRow) => void;
    onDelete?: (furnitureUid: string) => void;
  }, restaurantId?: bigint): void {
    if (!this.conn) return;
    const rid = restaurantId ?? this.restaurantId;
    if (rid == null) return;
    type ServerRow = {
      furnitureUid: string;
      restaurantId: bigint;
      defId: string;
      plates: number;
      glasses: number;
      cycleTimeRemainingMs: bigint;
      platesTiers?: string | null;
      glassesTiers?: string | null;
    };
    const toClientRow = (r: ServerRow): DishwasherBatchRow => ({
      furnitureUid: r.furnitureUid,
      defId: r.defId,
      plates: r.plates,
      glasses: r.glasses,
      cycleTimeRemainingMs: r.cycleTimeRemainingMs,
      platesTiers: r.platesTiers ?? "",
      glassesTiers: r.glassesTiers ?? "",
    });
    try {
      if (handlers.onInsert) {
        this.conn.db.dishwasher_batch.onInsert((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onInsert!(toClientRow(row));
        });
      }
      if (handlers.onUpdate) {
        this.conn.db.dishwasher_batch.onUpdate((_ctx, _old: ServerRow, newRow: ServerRow) => {
          if (newRow.restaurantId !== rid) return;
          handlers.onUpdate!(toClientRow(newRow));
        });
      }
      if (handlers.onDelete) {
        this.conn.db.dishwasher_batch.onDelete((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onDelete!(row.furnitureUid);
        });
      }
    } catch (e) {
      console.warn("[Cloud] subscribeDishwasherBatchChanges failed:", e);
    }
  }

  /** Phase I (H.B) — Subscribe to dirty_pile changes for the visited
   * restaurant. Same insert/update/delete shape as the other live
   * subscriptions. */
  subscribeDirtyPileChanges(handlers: {
    onInsert?: (row: DirtyPileRow) => void;
    onUpdate?: (row: DirtyPileRow) => void;
    onDelete?: (id: bigint) => void;
  }, restaurantId?: bigint): void {
    if (!this.conn) return;
    const rid = restaurantId ?? this.restaurantId;
    if (rid == null) return;
    type ServerRow = {
      id: bigint;
      restaurantId: bigint;
      seatUid: string;
      kind: string;
      tier: number;
      slotIndex: number;
      floor: number;
      x: number;
      z: number;
      claimedBy: string;
    };
    const toClientRow = (r: ServerRow): DirtyPileRow => ({
      id: r.id, seatUid: r.seatUid, kind: r.kind, tier: r.tier,
      slotIndex: r.slotIndex, floor: r.floor, x: r.x, z: r.z,
      claimedBy: r.claimedBy,
    });
    try {
      if (handlers.onInsert) {
        this.conn.db.dirty_pile.onInsert((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onInsert!(toClientRow(row));
        });
      }
      if (handlers.onUpdate) {
        this.conn.db.dirty_pile.onUpdate((_ctx, _old: ServerRow, newRow: ServerRow) => {
          if (newRow.restaurantId !== rid) return;
          handlers.onUpdate!(toClientRow(newRow));
        });
      }
      if (handlers.onDelete) {
        this.conn.db.dirty_pile.onDelete((_ctx, row: ServerRow) => {
          if (row.restaurantId !== rid) return;
          handlers.onDelete!(row.id);
        });
      }
    } catch (e) {
      console.warn("[Cloud] subscribeDirtyPileChanges failed:", e);
    }
  }

  /** Phase I (H.B) — Snapshot the dirty piles for the current
   * restaurant. Used by the host's wash trip dispatcher post-H.D. */
  listDirtyPiles(): DirtyPileRow[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: DirtyPileRow[] = [];
    const rid = this.restaurantId;
    try {
      for (const r of this.conn.db.dirty_pile.iter()) {
        if (r.restaurantId !== rid) continue;
        out.push({
          id: r.id, seatUid: r.seatUid, kind: r.kind, tier: r.tier,
          slotIndex: r.slotIndex, floor: r.floor, x: r.x, z: r.z,
          claimedBy: r.claimedBy,
        });
      }
    } catch { /* table not wired */ }
    return out;
  }

  /** Phase I (H.B) — Host's mirror call when its local sim spawns a
   * leftover (settleGuestDishes → spawnLeftoversForGuest). Fire-and-
   * forget; server assigns the auto_inc id and echoes back via
   * subscription, where the visualizer picks it up. */
  addDirtyPile(args: {
    seatUid: string; kind: "plate" | "glass"; tier: number;
    slotIndex: number; floor: number; x: number; z: number;
  }): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.addDirtyPile({
        restaurantId: this.restaurantId,
        seatUid: args.seatUid,
        kind: args.kind,
        tier: args.tier,
        slotIndex: args.slotIndex,
        floor: args.floor,
        x: args.x,
        z: args.z,
      });
    } catch (e) {
      console.warn("[Cloud] addDirtyPile failed:", e);
    }
  }

  pickupDirtyPile(id: bigint): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.pickupDirtyPile({ id });
    } catch (e) {
      console.warn("[Cloud] pickupDirtyPile failed:", e);
    }
  }

  /** Host-side cleanup: when the local sim's pickupDirty(localId)
   * fires, we don't have the cloud row's auto_inc id handy. This
   * deletes the FIRST matching unclaimed pile by (seat_uid, kind)
   * so the mirror eventually drains. See server reducer doc. */
  pickupDirtyPileBySeat(seatUid: string, kind: "plate" | "glass"): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.pickupDirtyPileBySeat({
        restaurantId: this.restaurantId,
        seatUid,
        kind,
      });
    } catch (e) {
      console.warn("[Cloud] pickupDirtyPileBySeat failed:", e);
    }
  }

  /** Upsert one dishwasher's mid-cycle state. H.93 adds the tier
   * CSVs so the wash cycle preserves per-plate tier (was being lost
   * pre-H.93 — T5 wash returned T1). */
  updateDishwasherBatch(
    furnitureUid: string,
    defId: string,
    plates: number,
    glasses: number,
    cycleTimeRemainingMs: bigint,
    platesTiers: string = "",
    glassesTiers: string = "",
  ): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.updateDishwasherBatch({
        restaurantId: this.restaurantId,
        furnitureUid, defId, plates, glasses, cycleTimeRemainingMs,
        platesTiers, glassesTiers,
      });
    } catch (e) {
      console.warn("[Cloud] updateDishwasherBatch failed:", e);
    }
  }

  /** Phase I.5 (H.59) — List the achievement ids the server has
   * recorded as unlocked for the current identity.  Caller is
   * Engine.onSubscriptionReady, which calls
   * AchievementSystem.markUnlockedSilent for each id so toasts don't
   * re-fire for already-unlocked achievements. */
  listMyAchievements(): string[] {
    if (!this.conn || !this.identity) return [];
    const me = this.identity;
    const out: string[] = [];
    try {
      for (const row of this.conn.db.achievement_unlock.player.filter(me)) {
        out.push(row.achievementId);
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Fetch the cached save snapshot for the given identity (returns
   * null if the player hasn't published yet). Used by P4 visit mode
   * to load another player's restaurant state. */
  getPlayerSave(identity: Identity): { data: string; dayNumber: number; money: number; ratingAvg: number; luxuryTier: number; updatedAt: bigint } | null {
    if (!this.conn) return null;
    try {
      for (const row of this.conn.db.player_save.iter()) {
        if (!identityEquals(row.identity, identity)) continue;
        return {
          data: row.data,
          dayNumber: row.dayNumber,
          money: Number(row.money),
          ratingAvg: row.ratingAvg,
          luxuryTier: row.luxuryTier,
          // microsTimestamp comes back as { __timestamp_micros_since_unix_epoch__: bigint }
          // Just return a bigint of the micros value for simplicity.
          updatedAt: (row.updatedAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0),
        };
      }
    } catch { /* table not yet wired */ }
    return null;
  }

  /** The username the player logged in as (persisted, lowercased to match the
   * server's account_save key). Null if never logged in on this device. */
  private myUsername(): string | null {
    try {
      const u = localStorage.getItem("cozy-bistro.username");
      return u ? u.trim().toLowerCase() : null;
    } catch { return null; }
  }

  /** The ACCOUNT-keyed canonical save (account_save) for a username — stable
   * across devices/sessions, unlike the churning per-identity player_save. */
  getAccountSave(username: string): { data: string; dayNumber: number; money: number; ratingAvg: number; luxuryTier: number } | null {
    if (!this.conn) return null;
    const lc = username.trim().toLowerCase();
    try {
      for (const row of this.conn.db.account_save.iter()) {
        if (row.username !== lc) continue;
        return {
          data: row.data,
          dayNumber: row.dayNumber,
          money: Number(row.money),
          ratingAvg: row.ratingAvg,
          luxuryTier: row.luxuryTier,
        };
      }
    } catch { /* table not yet wired */ }
    return null;
  }

  /** The save a session should load: the account-keyed save (stable, by
   * username) if we have one, else the legacy per-identity save. This is what
   * makes any device / incognito load the SAME restaurant. */
  private getCanonicalSave(): { data: string; dayNumber: number; money: number; ratingAvg: number; luxuryTier: number } | null {
    const u = this.myUsername();
    if (u) {
      const acct = this.getAccountSave(u);
      if (acct && acct.data) return acct;
    }
    return this.identity ? this.getPlayerSave(this.identity) : null;
  }

  /** Every known account on this server (auth_record snapshot).
   * SocialModal's username search drives off this. Includes self
   * unless the caller filters. */
  listAccounts(): { username: string; displayName: string; identity: Identity; isAdmin: boolean; isMe: boolean }[] {
    if (!this.conn) return [];
    const me = this.identity;
    const out: { username: string; displayName: string; identity: Identity; isAdmin: boolean; isMe: boolean }[] = [];
    try {
      for (const a of this.conn.db.auth_record.iter()) {
        if (!a.username) continue; // skip placeholders if any
        out.push({
          username: a.username,
          displayName: a.displayName,
          identity: a.identity,
          isAdmin: a.isAdmin,
          isMe: me ? identityEquals(a.identity, me) : false,
        });
      }
    } catch { /* not wired yet */ }
    return out;
  }

  /** Current logged-in account info, or null when unauthenticated. */
  getCurrentAccount(): { username: string; displayName: string; isAdmin: boolean } | null {
    if (!this.conn || !this.identity) return null;
    const me = this.identity;
    try {
      for (const r of this.conn.db.auth_record.iter()) {
        if (identityEquals(r.identity, me)) {
          return { username: r.username, displayName: r.displayName, isAdmin: r.isAdmin };
        }
      }
    } catch { /* not wired */ }
    return null;
  }

  /** Call sign_up. Resolves on success, rejects with the reducer's
   * error string (e.g. "Username already taken"). `rememberMe`
   * controls whether the identity token is stored in localStorage
   * (true, default — survives browser restart) or sessionStorage
   * (false — cleared on tab close). */
  async signUp(username: string, password: string, rememberMe = true): Promise<void> {
    this.setRememberMe(rememberMe);
    await this.callReducer("signUp", () => this.conn!.reducers.signUp({ username, password }));
    // Same race fix as login() — the auth_record insert needs to
    // round-trip via subscription before isAuthenticated() returns true.
    await this.waitForAuthRecord();
  }

  /** Poll the local auth_record cache for up to AUTH_WAIT_TIMEOUT_MS
   * waiting for a row matching the current identity to appear.
   * Called by login()/signUp() right after the reducer applies so
   * the caller sees a consistent isAuthenticated()=true on return.
   *
   * No-op when there's no connection (caller will see "Not
   * connected" elsewhere).  Silently times out (logs a warn) if
   * the row never arrives — the LoginModal will then surface
   * "Login failed" which prompts a retry; better than throwing
   * from inside a successful reducer call.  10 ms poll interval +
   * 3000 ms cap is plenty for a same-region SpacetimeDB host. */
  private async waitForAuthRecord(): Promise<void> {
    const AUTH_WAIT_TIMEOUT_MS = 3000;
    const POLL_INTERVAL_MS = 25;
    const deadline = Date.now() + AUTH_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.isAuthenticated()) return;
      await new Promise<void>((r) => window.setTimeout(r, POLL_INTERVAL_MS));
    }
    console.warn("[SpacetimeClient] auth_record didn't arrive within "
      + `${AUTH_WAIT_TIMEOUT_MS}ms after login — likely a subscription delay; `
      + "caller will surface 'Login failed'.");
  }

  /** Call login. Resolves on success, rejects with the reducer's
   * error string (e.g. "Wrong password"). `rememberMe` controls
   * whether the identity token is stored in localStorage (true,
   * default — survives browser restart) or sessionStorage (false —
   * cleared on tab close).
   *
   * After the reducer applies, this also WAITS for the resulting
   * auth_record row to propagate back via subscription so that
   * `isAuthenticated()` returns true the moment we resolve.
   * Without this, callers (LoginModal) would see the row missing
   * on the very next line and flash "Login failed" even though
   * the server happily accepted the credentials.  Timing race
   * became visible after publishes that disconnect all clients
   * — the auth_record subscription cache starts cold on reconnect. */
  async login(username: string, password: string, rememberMe = true): Promise<void> {
    this.setRememberMe(rememberMe);
    await this.callReducer("login", () => this.conn!.reducers.login({ username, password }));
    await this.waitForAuthRecord();
    // Persist the account name so the ACCOUNT-keyed save (account_save) resolves
    // on this device — including on later token-reconnects that never call
    // login() again.
    try { localStorage.setItem("cozy-bistro.username", username); } catch { /* ignore */ }
    // Cross-device: the login reducer just transferred this account's
    // restaurant + player_save to our identity (auth.rs
    // transfer_identity_resources). If we booted FRESH (incognito / new
    // device) the initial subscription took the "no restaurant" branch and
    // never loaded the cloud save, so we'd be staring at a day-1 shell. Pull
    // the canonical save now (it reloads us into the real game).
    await this.loadCloudSaveAfterLogin();
  }

  /** After a successful login on a FRESH-START session, wait for the
   * just-transferred player_save row to land in the subscription, then
   * auto-load it (writes localStorage + reloads into the real game). No-op for
   * a returning player who already had a local save, or a brand-new account
   * with no cloud save yet (poll times out → they proceed to the picker). */
  private async loadCloudSaveAfterLogin(): Promise<void> {
    if (this.cloudAutoLoadTriggered) return;
    if (!this.conn || !this.identity) return;
    // The transfer (restaurant.owner + player_save.identity → us) can land a
    // few subscription ticks after the auth_record update — poll ~12s.
    const u = this.myUsername();
    for (let i = 0; i < 48; i += 1) {
      void this.getMyRestaurantId(); // lazy re-scan also resolves restaurantId
      // STRONGLY prefer the ACCOUNT-keyed save. If we know our username, WAIT
      // for account_save to arrive in the subscription before falling back to a
      // possibly-shell per-identity save — otherwise the very first tick loads
      // the incognito's day-1 shell and we never see the real tier-5. Allow the
      // per-identity fallback only with no username, or after ~5s of waiting.
      const acct = u ? this.getAccountSave(u) : null;
      const fallback = !acct && (!u || i >= 20) && this.identity ? this.getPlayerSave(this.identity) : null;
      const mySave = acct ?? fallback;
      if (mySave && mySave.data) {
        const localDay = this.game.day.getDayNumber();
        const localTier = this.game.getLuxuryTier();
        const localIsShell = localDay <= 1 && localTier <= 1;
        const cloudSubstantial = mySave.dayNumber >= 10 || mySave.luxuryTier >= 2;
        if (this.wasFreshStart || (localIsShell && cloudSubstantial)) {
          console.log(`[SpacetimeDB] post-login — loading ${acct ? "account_save" : "player_save"} (day ${mySave.dayNumber}/tier ${mySave.luxuryTier} over local day ${localDay}/tier ${localTier})`);
          this.maybeAutoLoadCloudSave({ data: mySave.data }, true);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.warn("[SpacetimeDB] post-login: no cloud save arrived after ~12s");
  }

  /** Call logout. Releases this identity's claim on the account on
   * the server, then wipes the stored auth token from both
   * localStorage and sessionStorage so the next reload starts as
   * an anonymous client and the LoginModal pops fresh.  Without
   * the token clear, a re-login under a DIFFERENT username would
   * still inherit the old identity from the cached token — the
   * server logout drops the auth_record link, but the wallet-style
   * identity stays the same per-browser. */
  async logout(): Promise<void> {
    await this.callReducer("logout", () => this.conn!.reducers.logout({}));
    try {
      const key = tokenStorageKeyFor(this.cfg.host);
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
      // Clear the persisted account name too — otherwise a re-login as a
      // DIFFERENT user would resolve the OLD username and load the wrong
      // account's save (account-keyed save). [bug-sweep fix]
      localStorage.removeItem("cozy-bistro.username");
    } catch { /* private-mode storage — ignore */ }
  }

  /** Submit a forgot-password ticket for the admin to action. The
   * message is a free-text "what happened" blurb. */
  requestPasswordReset(username: string, message: string): Promise<void> {
    return this.callReducer("requestPasswordReset", () =>
      this.conn!.reducers.requestPasswordReset({ username, message }));
  }

  // ============================================================================
  //                          P7 — ADMIN ACTIONS
  // ============================================================================

  /** Admin-only — list all pending password-reset requests. Returns
   * empty if there are none or the caller isn't connected. The UI
   * filters server-side enforcement is the actual gate (reducer
   * rejects non-admin callers); this helper just reads the public
   * table. */
  listResetRequests(): { id: bigint; username: string; message: string; status: string; createdAtMs: number }[] {
    if (!this.conn) return [];
    const out: { id: bigint; username: string; message: string; status: string; createdAtMs: number }[] = [];
    try {
      for (const r of this.conn.db.password_reset_request.iter()) {
        out.push({
          id: r.id,
          username: r.username,
          message: r.message,
          status: r.status,
          createdAtMs: Number((r.createdAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0)) / 1000,
        });
      }
    } catch { /* table not wired */ }
    return out;
  }

  /** Admin-only — set a new password for the target account and mark
   * the reset request resolved (pass requestId=0n for ad-hoc resets
   * not tied to a ticket). */
  adminResetPassword(targetUsername: string, newPassword: string, requestId: bigint = 0n): Promise<void> {
    return this.callReducer("adminResetPassword", () =>
      this.conn!.reducers.adminResetPassword({ targetUsername, newPassword, requestId }));
  }

  /** Every account currently banned. Reads the ban_record table. */
  listBans(): { username: string; reason: string; bannedAtMs: number }[] {
    if (!this.conn) return [];
    const out: { username: string; reason: string; bannedAtMs: number }[] = [];
    try {
      for (const b of this.conn.db.ban_record.iter()) {
        out.push({
          username: b.username,
          reason: b.reason,
          bannedAtMs: Number((b.bannedAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0)) / 1000,
        });
      }
    } catch { /* not wired */ }
    return out;
  }

  /** True iff there's a ban_record row for the given username. */
  isBanned(username: string): boolean {
    if (!this.conn) return false;
    const lc = username.trim().toLowerCase();
    try {
      return this.conn.db.ban_record.username.find(lc) !== undefined;
    } catch { return false; }
  }

  /** Admin-only — ban a player by username, releasing their building. */
  adminBanPlayer(targetUsername: string, reason: string): Promise<void> {
    return this.callReducer("adminBanPlayer", () =>
      this.conn!.reducers.adminBanPlayer({ targetUsername, reason }));
  }

  /** Admin-only — lift a ban (auth_record + save data untouched). */
  adminUnbanPlayer(targetUsername: string): Promise<void> {
    return this.callReducer("adminUnbanPlayer", () =>
      this.conn!.reducers.adminUnbanPlayer({ targetUsername }));
  }

  /** Admin-only — wipe a player's save + release their building. */
  adminDeleteRestaurant(targetUsername: string): Promise<void> {
    return this.callReducer("adminDeleteRestaurant", () =>
      this.conn!.reducers.adminDeleteRestaurant({ targetUsername }));
  }

  /** Self-service character wipe — releases THIS player's building
   * and nukes their player_save / leaderboard / achievement rows.
   * Username + password are preserved so they can log back in and
   * pick a new plot. Wraps the wipe_my_restaurant reducer. Called
   * from the HUD's "Reset save" button after the player confirms
   * the warning dialog. */
  wipeMyRestaurant(): Promise<void> {
    return this.callReducer("wipeMyRestaurant", () =>
      this.conn!.reducers.wipeMyRestaurant({}));
  }

  // ============================================================================
  //                           P8 — CHAT
  // ============================================================================

  /** Build the canonical PM channel id for a pair of identity hex
   * strings. Stable regardless of order so the same conversation
   * maps to the same channel for both participants. Mirrors the
   * server's `pm_channel_for` so client-side filtering matches. */
  static pmChannelFor(meHex: string, otherHex: string): string {
    const me = meHex.toLowerCase();
    const other = otherHex.toLowerCase();
    const [a, b] = me <= other ? [me, other] : [other, me];
    return `pm:${a}|${b}`;
  }

  /** Read all messages on a given channel, sorted oldest-first. The
   * channel id is either "global" or "pm:<hex>|<hex>" (use
   * SpacetimeClient.pmChannelFor to build the latter). */
  listChatMessages(channel: string, limit = 200): { id: bigint; senderHex: string; senderName: string; text: string; sentAtMs: number; isMine: boolean }[] {
    if (!this.conn) return [];
    const me = this.identity?.toHexString() ?? "";
    const rows: { id: bigint; senderHex: string; senderName: string; text: string; sentAtMs: number; isMine: boolean }[] = [];
    try {
      for (const m of this.conn.db.chat_message.iter()) {
        if (m.channel !== channel) continue;
        const hex = m.sender.toHexString();
        rows.push({
          id: m.id,
          senderHex: hex,
          senderName: this.displayNameFor(hex),
          text: m.text,
          sentAtMs: Number((m.sentAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0)) / 1000,
          isMine: hex === me,
        });
      }
    } catch { /* table not yet wired */ }
    rows.sort((a, b) => a.sentAtMs - b.sentAtMs);
    return rows.slice(-limit);
  }

  /** Set of channel ids that have any messages where I'm one of the
   * participants — drives auto-discovery of PM tabs the player has
   * received but not yet opened. Returns an array of `{channel,
   * otherHex, otherName}` for every PM conversation involving me. */
  listMyPmConversations(): { channel: string; otherHex: string; otherName: string }[] {
    if (!this.conn || !this.identity) return [];
    const meHex = this.identity.toHexString().toLowerCase();
    const seen = new Map<string, string>(); // channel → otherHex
    try {
      for (const m of this.conn.db.chat_message.iter()) {
        if (!m.channel.startsWith("pm:")) continue;
        // Parse "pm:hexA|hexB" — return the half that isn't me.
        const body = m.channel.slice(3);
        const [a, b] = body.split("|");
        if (!a || !b) continue;
        const aLc = a.toLowerCase(); const bLc = b.toLowerCase();
        let other: string;
        if (aLc === meHex) other = bLc;
        else if (bLc === meHex) other = aLc;
        else continue; // not my conversation
        if (!seen.has(m.channel)) seen.set(m.channel, other);
      }
    } catch { /* ignore */ }
    const out: { channel: string; otherHex: string; otherName: string }[] = [];
    for (const [channel, otherHex] of seen) {
      out.push({ channel, otherHex, otherName: this.displayNameFor(otherHex) });
    }
    return out;
  }

  /** Send a message to the global channel. */
  sendChatGlobal(text: string): Promise<void> {
    return this.callReducer("sendChatGlobal", () =>
      this.conn!.reducers.sendChatGlobal({ text }));
  }

  /** Send a private message to the player with the given identity hex. */
  sendChatPrivate(recipientHex: string, text: string): Promise<void> {
    if (!this.conn) return Promise.reject(new Error("Not connected"));
    let recipient: Identity;
    try {
      recipient = Identity.fromString(recipientHex);
    } catch (e) {
      return Promise.reject(new Error("Invalid recipient identity"));
    }
    return this.callReducer("sendChatPrivate", () =>
      this.conn!.reducers.sendChatPrivate({ recipient, text }));
  }

  /** Resolve a hex identity to a display name. Prefers auth_record's
   * display_name (matches what other players see in social UI), then
   * falls back to player.name, then to a shortened hex. */
  displayNameFor(hex: string): string {
    if (!this.conn) return shortHex(hex);
    const lc = hex.toLowerCase();
    try {
      for (const a of this.conn.db.auth_record.iter()) {
        if (a.identity.toHexString().toLowerCase() === lc) return a.displayName || a.username;
      }
    } catch { /* ignore */ }
    try {
      for (const p of this.conn.db.player.iter()) {
        if (p.identity.toHexString().toLowerCase() === lc) return p.name || shortHex(hex);
      }
    } catch { /* ignore */ }
    return shortHex(hex);
  }

  /** Register a callback fired for every new chat_message insert (any
   * channel). Returns an unsubscribe fn. The ChatPanel uses this to
   * bump unread counts for tabs that aren't currently focused and to
   * surface a toast for incoming PMs while the panel is minimized. */
  onChatMessage(cb: (m: { id: bigint; channel: string; senderHex: string; senderName: string; text: string; sentAtMs: number; isMine: boolean }) => void): () => void {
    this.chatMessageListeners.add(cb);
    return () => { this.chatMessageListeners.delete(cb); };
  }

  /** Fire one reducer call and surface its actual outcome. The
   * SpacetimeDB SDK's reducer accessor returns a Promise that
   * resolves on success and rejects with `SenderError(message)` on
   * server-side rejection (e.g. login returning "Wrong password"
   * via `Err(...)`).  We forward the rejection's message string to
   * the modal so users see the real error instead of the old
   * "Server didn't respond in time" timeout.
   *
   * Also keeps a 10 s safety cap so a dropped connection still
   * surfaces SOMETHING rather than hanging the modal forever. */
  private async callReducer(_label: string, fire: () => Promise<void> | void): Promise<void> {
    if (!this.conn) throw new Error("Not connected");
    const TIMEOUT_MS = 10_000;
    let timeoutId: number | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        reject(new Error("Server didn't respond in time"));
      }, TIMEOUT_MS);
    });
    try {
      // Race the SDK call against the timeout. If the SDK rejects
      // (server returned Err), the rejection wins and carries the
      // real error message.
      const callPromise = (async () => fire())();
      await Promise.race([callPromise, timeoutPromise]);
    } catch (e) {
      // Strip the SenderError wrapping for display. The SDK formats
      // these as "Reducer call failed: <message>" or carries the raw
      // server string; just pass the message through.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg);
    } finally {
      if (timeoutId != null) window.clearTimeout(timeoutId);
    }
  }

  /** Build the connection and start listening. Safe to await; failures
   * only log + leave the game running offline.
   *
   * Token lookup order:
   *   1) sessionStorage — present means the user logged in last time
   *      with "Remember me" UNCHECKED. We use it so the in-tab refresh
   *      experience is seamless, but the token dies with the tab.
   *   2) localStorage — present means "Remember me" was checked.
   *      Survives browser restart.
   * If we find a session-storage token we flip rememberMe to false
   * for this session so the onConnect write-back goes to the same
   * place (otherwise we'd silently "upgrade" the user to remembered). */
  connect(): void {
    const tokenKey = tokenStorageKeyFor(this.cfg.host);
    // One-time migration: if an unscoped legacy token exists (from
    // before the per-host scoping), nuke it.  It was likely signed
    // by Maincloud and would just confuse a self-hosted server.
    try {
      if (localStorage.getItem(TOKEN_KEY_BASE) != null) {
        localStorage.removeItem(TOKEN_KEY_BASE);
      }
      if (sessionStorage.getItem(TOKEN_KEY_BASE) != null) {
        sessionStorage.removeItem(TOKEN_KEY_BASE);
      }
    } catch { /* private-mode storage error — proceed */ }
    let stored: string | undefined;
    try {
      const sessionTok = sessionStorage.getItem(tokenKey);
      if (sessionTok) {
        stored = sessionTok;
        this.rememberMe = false;
      } else {
        stored = localStorage.getItem(tokenKey) ?? undefined;
        // rememberMe stays at its current value (default true)
      }
    } catch { /* private-mode storage error — connect anyway */ }
    let builder = DbConnection.builder()
      .withUri(this.cfg.host)
      .withDatabaseName(this.cfg.moduleName)
      .onConnect((conn, identity, token) => {
        this.persistToken(token);
        console.log("[SpacetimeDB] connected as", identity.toHexString());
        this.identity = identity;
        this.afterConnect(conn, identity);
      })
      .onDisconnect(() => {
        console.warn("[SpacetimeDB] disconnected");
        this.handleUnexpectedDisconnect();
      })
      .onConnectError((_ctx: ErrorContext, err: Error) => {
        console.error("[SpacetimeDB] connect error", err);
        // If the server rejected our stored token (auth failed,
        // signature mismatch from a different host, etc.), nuke it
        // and tell the user to retry — the next connect will be
        // anonymous and the LoginModal will let them sign up cleanly.
        try {
          sessionStorage.removeItem(tokenKey);
          localStorage.removeItem(tokenKey);
        } catch { /* ignore */ }
      });
    if (stored) builder = builder.withToken(stored);
    try {
      this.conn = builder.build();
    } catch (e) {
      console.error("[SpacetimeDB] failed to build connection", e);
    }
  }

  /** Auto-recover from a dropped connection. The common cause here is the
   * tab being frozen long enough (a heavy shader compile on a floor
   * change) that the server's heartbeat times us out — afterwards the
   * client is connected to nothing, so the server-driven guests + staff
   * freeze while client-side timers keep ticking. A page reload cleanly
   * re-runs the whole connect → subscribe → adopt-state flow, which is far
   * safer than splicing a fresh socket into live game state. Guarded
   * against reload loops: if we already reloaded for this within the last
   * few seconds (a real outage, not a one-off freeze), show a manual
   * Reconnect button instead of thrashing. */
  private handleUnexpectedDisconnect(): void {
    if (this.intentionalDisconnect) return;
    // The socket is dead. Drop it + flag the loss so reducer wrappers
    // cleanly no-op and the server-ownership gates fall back to local sim
    // during the reconnect window — otherwise guests/staff freeze in place
    // (the server can't push and the gates still think it owns them) until
    // the reload lands, or indefinitely on the manual-reconnect path below.
    this.connectionLost = true;
    this.conn = null;
    const KEY = "cozy-bistro.lastReconnectReload";
    let lastReload = 0;
    try { lastReload = parseInt(sessionStorage.getItem(KEY) ?? "0", 10) || 0; } catch { /* ignore */ }
    const now = Date.now();
    const banner = document.createElement("div");
    Object.assign(banner.style, {
      position: "fixed", top: "0", left: "0", right: "0", padding: "10px 16px",
      zIndex: "100001", background: "rgba(40, 70, 120, 0.96)", color: "#fff",
      font: "13px system-ui, sans-serif", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    if (now - lastReload < 8000) {
      // Reloaded very recently — likely a genuine outage. Don't loop.
      banner.textContent = "⚠️ Lost connection to the server.";
      const btn = document.createElement("button");
      btn.textContent = "Reconnect";
      Object.assign(btn.style, {
        marginLeft: "10px", padding: "3px 12px", cursor: "pointer", font: "inherit",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => window.location.reload();
      banner.appendChild(btn);
      document.body.appendChild(banner);
      return;
    }
    banner.textContent = "Connection lost — reconnecting…";
    document.body.appendChild(banner);
    try { sessionStorage.setItem(KEY, String(now)); } catch { /* ignore */ }
    window.setTimeout(() => window.location.reload(), 1500);
  }

  /** False after an unexpected disconnect (until the page reloads). The
   * server-ownership gates consult this so the local sim takes over the
   * reconnect window instead of leaving guests/staff frozen. */
  isConnectionLive(): boolean {
    return !this.connectionLost;
  }

  /** Whether the player's identity token is persisted across browser
   * restarts. True (default) writes to localStorage; false writes to
   * sessionStorage and removes any existing localStorage entry. The
   * LoginModal's "Remember me" checkbox flips this via setRememberMe
   * before submitting credentials. */
  private rememberMe = true;

  /** Update the persistence mode for the identity token. Called by
   * login() / signUp() with the checkbox state. Also migrates any
   * already-stored token between localStorage and sessionStorage so
   * the choice takes effect immediately, not only on the NEXT
   * connect — important because the SDK's initial connect happens
   * BEFORE the user sees the login form. */
  setRememberMe(b: boolean): void {
    this.rememberMe = b;
    const tokenKey = tokenStorageKeyFor(this.cfg.host);
    try {
      const fromLocal = localStorage.getItem(tokenKey);
      const fromSession = sessionStorage.getItem(tokenKey);
      const token = fromLocal ?? fromSession;
      if (!token) return;
      if (b) {
        // Promote to permanent storage.
        localStorage.setItem(tokenKey, token);
        sessionStorage.removeItem(tokenKey);
      } else {
        // Demote to session-only storage; wipe permanent copy so a
        // browser close really clears the identity.
        sessionStorage.setItem(tokenKey, token);
        localStorage.removeItem(tokenKey);
      }
    } catch { /* ignore quota / private mode */ }
  }

  /** Write the identity token to whichever storage matches the
   * current rememberMe preference. Pairs with connect() reading
   * from the same place. */
  private persistToken(token: string): void {
    const tokenKey = tokenStorageKeyFor(this.cfg.host);
    try {
      if (this.rememberMe) {
        localStorage.setItem(tokenKey, token);
        sessionStorage.removeItem(tokenKey);
      } else {
        sessionStorage.setItem(tokenKey, token);
        localStorage.removeItem(tokenKey);
      }
    } catch { /* ignore */ }
  }

  /** Wire up the bridges between Game events and reducer calls. Called
   * once after the initial subscription completes so the local cache
   * has the player's existing restaurant + save row. */
  private afterConnect(conn: DbConnection, identity: Identity): void {
    if (this.wired) return;
    // Subscribe to everything (small data volume for v0). Once the
    // initial snapshot lands, find or create this player's restaurant.
    conn.subscriptionBuilder()
      .onApplied((ctx: SubscriptionEventContext) => {
        this.onSubscriptionReady(ctx, identity);
      })
      .subscribeToAllTables();
  }

  private onSubscriptionReady(ctx: SubscriptionEventContext, identity: Identity): void {
    const conn = this.conn!;
    // Find one of my restaurants. Note: table accessors on `ctx.db`
    // are snake_case (matches the schema name), index accessors are
    // also snake_case (e.g. `.restaurant_id`).
    //
    // Phase I (H.96) — Pre-H.96 we auto-created a Restaurant here
    // when none existed. That race could leave the user with a
    // Restaurant but no Building (or vice versa) after a wipe /
    // partial migration. Now claim_building atomically creates the
    // Restaurant alongside the Building claim, so the only flow
    // that materialises a Restaurant is the BuildingPickModal +
    // claim_building one. We still listen for inserts so the late-
    // arriving row picks up restaurantId when the modal completes.
    const myRestaurants = Array.from(ctx.db.restaurant.iter())
      .filter((r) => identityEquals(r.owner, identity));
    if (myRestaurants.length === 0) {
      console.log("[SpacetimeDB] no restaurants for this identity — awaiting BuildingPickModal → claim_building flow");
      const onInsert = (_evCtx: unknown, row: { id: bigint; owner: Identity }): void => {
        if (this.restaurantId != null) return;
        if (!identityEquals(row.owner, identity)) return;
        this.restaurantId = row.id;
        this.flushPendingActiveMenu();
        console.log(`[SpacetimeDB] restaurant ${row.id} arrived — cloud saves enabled`);
        try { ctx.db.restaurant.removeOnInsert(onInsert); } catch { /* SDK quirk */ }
      };
      ctx.db.restaurant.onInsert(onInsert);
      // No createRestaurant call — Engine.afterAuth will show the
      // BuildingPickModal which fires claim_building → server-side
      // auto-creates the Restaurant atomically.
      void conn;
    } else {
      this.restaurantId = myRestaurants[0].id;
      this.flushPendingActiveMenu();
      // Read the CURRENT, identity-keyed player_save blob — NOT the legacy
      // restaurant-keyed save_snapshot, whose blob goes stale (live: it held
      // tier 1 / day 1 while the real player_save was tier 5 / day 1486, so a
      // fresh device restored a tier-1 game: locked upper floors, no
      // upgrades, no staff roster, no decor). player_save is the table
      // cloudSaveNow keeps current.
      const mySave = this.getCanonicalSave();
      if (mySave && mySave.data) {
        const localDay = this.game.day.getDayNumber();
        const localTier = this.game.getLuxuryTier();
        const localIsShell = localDay <= 1 && localTier <= 1;
        const cloudSubstantial = mySave.dayNumber >= 10 || mySave.luxuryTier >= 2;
        console.log(`[SpacetimeDB] found cloud player_save — day ${mySave.dayNumber}, tier ${mySave.luxuryTier} ($${mySave.money}); local day ${localDay}/tier ${localTier} (shell=${localIsShell}, cloudSubstantial=${cloudSubstantial})`);
        // Pull the cloud save on a fresh device, OR when this device is sitting
        // on a day-1 SHELL while a substantial cloud save exists under our
        // identity. The shell case is the reconnect-via-token path (reopening
        // incognito doesn't call login(), so loadCloudSaveAfterLogin never runs)
        // plus incognito's shared storage keeping a stale shell alive past
        // wasFreshStart. A returning player with a real local game is left
        // alone; they can still use SlotsModal "Load from cloud".
        this.maybeAutoLoadCloudSave({ data: mySave.data }, this.wasFreshStart || (localIsShell && cloudSubstantial));
      } else {
        console.log(`[SpacetimeDB] restaurant ${this.restaurantId} exists but no player_save yet`);
      }
      // H.22 — drain any pending end-of-visit rollup the server
      // accumulated while this tab was backgrounded / disconnected.
      // Applied AFTER the save-load attempt so tips/served/ratings
      // get added ON TOP of the hydrated state rather than being
      // overwritten by it. maybeAutoLoadCloudSave either replaces
      // state synchronously (apply is now correct) OR triggers a
      // page reload (we never get here, fresh boot picks it up).
      this.applyPendingVisitRollup();
      // Phase 7.7 — Seed the delta-sync baseline from the cloud row
      // so the first 5s syncCloudMoney push doesn't fire a spurious
      // "I just earned $1M" delta.
      //
      // Phase 9.20 — DO NOT seed if the authoritative row hasn't been
      // adopted yet. The restaurant row in the subscription cache at
      // this point is often a STALE pre-settlement value; seeding the
      // baseline from it defeats the onUpdate adoption guard, so the
      // real offline-settled value lands seconds later as a live
      // "+$50k income" delta that reads like a dupe. Leaving the
      // baseline null when unadopted lets the first onUpdate adopt
      // cleanly (setMoney + one labelled reconciliation line). Engine's
      // 5s push is itself guarded on lastSynced !== null, so there's no
      // spurious push in the gap. We only seed here once adoption has
      // already happened (rollup's setMoney path sets the flag below).
      const restRow = this.conn?.db.restaurant.id.find(this.restaurantId);
      if (restRow != null && this.moneyAdoptedThisSession) {
        this.game.economy.noteSyncedCents(Number(restRow.cloudMoneyCents));
      }
      // H.30 — same shape for day rollovers. Each pending day fires
      // Game.rolloverDay() which charges rent (past grace days),
      // resets daily totals, pushes a history row, and increments
      // dayNumber. Applying AFTER the visit rollup means today's
      // accumulated tips count toward today's daily revenue, then
      // the rollover snapshots + resets it cleanly.
      this.applyPendingDayAdvancement();
    }
    this.wireGameHooks();
    this.wireCloudListeners(ctx);
    // Presence heartbeat — keeps last_seen_at fresh so the HUD's
    // online-count is accurate. 30 s cadence + 90 s "online window"
    // on the read side gives us 3 missed pings before someone drops
    // from the count (handles slow networks / sleeping tabs).
    this.heartbeatTimer = window.setInterval(() => {
      try { this.conn?.reducers.pingPresence({}); } catch { /* ignore */ }
    }, 30_000);
    // Fire one immediately so the first count reflects this player.
    try { this.conn?.reducers.pingPresence({}); } catch { /* ignore */ }
    this.wired = true;
    this.notify();
  }

  /** Wire onInsert/onUpdate/onDelete for the tables UI panels care about,
   * so they re-render when remote state changes. */
  private wireCloudListeners(ctx: SubscriptionEventContext): void {
    const ping = (): void => this.notify();
    try {
      ctx.db.leaderboard_entry.onInsert(ping);
      ctx.db.leaderboard_entry.onUpdate(ping);
      ctx.db.friendship.onInsert(ping);
      ctx.db.friendship.onDelete(ping);
      ctx.db.friend_request.onInsert(ping);
      ctx.db.friend_request.onUpdate(ping);
      ctx.db.player.onInsert(ping);
      ctx.db.player.onUpdate(ping);
      ctx.db.restaurant.onInsert(ping);
      ctx.db.restaurant.onUpdate(ping);
      ctx.db.restaurant.onDelete(ping);
      // Phase 7.7 — Adopt server-driven cloud_money_cents changes into
      // the local economy. Server's accumulate_pending_visit_rollup,
      // tick_offline_salary, tick_day_clock (rent), try_restock_pantry,
      // and try_dispatch_errand_trip all bump cloud_money_cents
      // directly. Without this listener, those server adds would be
      // invisible to the host's HUD until the next syncCloudMoney
      // round-trip. Track the delta vs lastSyncedCents to skip the
      // bump-we-just-fired-ourselves case (no double-count).
      ctx.db.restaurant.onUpdate((_, oldRow, newRow) => {
        if (this.restaurantId == null) return;
        if (newRow.id !== this.restaurantId) return;
        // Phase 7.7/7.8 — Wrap the whole handler in a try-catch so a
        // mid-handler throw can't take down the subscription cascade.
        // Without this, ANY exception here (a stale local cache, a
        // future schema gap, an Engine system briefly null mid-init,
        // etc.) would unhandled-promise-reject inside the SDK's row-
        // application loop and silently block subsequent table updates
        // from being applied — including the auth_record row that
        // gates login. Logging is enough; the subscription will catch
        // up on the NEXT update event.
        try {
        // ── Phase 7.7 — Adopt server-driven cloud_money_cents changes ──
        const cloudCents = Number(newRow.cloudMoneyCents);
        const lastSynced = this.game.economy.getLastSyncedCents();
        if (lastSynced === null || !this.moneyAdoptedThisSession) {
          // Phase 9.3 + 9.20 — First AUTHORITATIVE row this session:
          // ADOPT, never delta. The cloud_money_cents total already
          // folds in everything the server earned while the tab was
          // closed, so the first row we trust is the offline-settled
          // value. setMoney REPLACES (can't compound past cloud);
          // earn()-ing the gap would (a) misreport real offline
          // earnings as live "Service income" and (b) — since
          // onSubscriptionReady seeds the baseline from a row that's
          // often still stale at boot — narrate a $50k+ jump seconds
          // after load that reads exactly like a dupe. The
          // moneyAdoptedThisSession flag makes this fire on the
          // FIRST onUpdate regardless of whether the baseline was
          // pre-seeded (the null guard alone wasn't enough — the
          // seed defeated it).
          const before = this.game.economy.getMoney();
          const after = cloudCents / 100;
          this.game.economy.setMoney(after);
          this.game.economy.noteSyncedCents(cloudCents);
          this.moneyAdoptedThisSession = true;
          // One honest reconciliation line so the books balance and
          // the jump is LABELLED (offline earnings/costs) instead of
          // looking like instantaneous live income. Skip sub-dollar
          // noise + the no-change case.
          const recon = after - before;
          if (Math.abs(recon) >= 1) {
            this.game.economy.recordTransaction(
              recon >= 0 ? "Offline earnings (while away)" : "Offline costs (while away)",
              recon,
            );
          }
        } else {
          const deltaCents = cloudCents - lastSynced;
          if (deltaCents !== 0) {
            // Convert to dollars and apply to local money. earn handles
            // positive delta (server credited a tip / revenue), charge
            // handles negative (server debited salary / rent / restock /
            // errand cost). Either way, log nothing in the transaction
            // log — these are server-originated changes that the player
            // didn't authorize via the local UI. Their reasons live in
            // the server-side log (log::info lines) and not the local
            // ledger UI.
            const deltaDollars = deltaCents / 100;
            // Adopt the authoritative server delta DIRECTLY. earn() is a
            // no-op under the money cutover (it stops LOCAL gameplay from
            // double-counting server income), so routing the positive branch
            // through it silently DROPPED every server-side increase here —
            // the admin +$ buttons, the "Set" control, the $500 grant, and
            // live tips/revenue — while debits (charge, unguarded) still
            // applied. That is the "dev tools only subtract" bug. This value
            // IS the server's, so adoptCloudDelta bypasses the cutover guard.
            this.game.economy.adoptCloudDelta(deltaDollars);
            this.game.economy.noteSyncedCents(cloudCents);
            // Phase 9.17 — make server-originated money VISIBLE in
            // the ledger. The Phase 7.7 "log nothing" decision left
            // the books showing only local salary charges while the
            // balance climbed from invisible service revenue — the
            // user reasonably read that as a dupe. Aggregate the
            // deltas and flush one line every ~10 s so a dinner rush
            // doesn't write a ledger row per plate.
            this.pendingServerLedger += deltaDollars;
            const nowMs = Date.now();
            if (nowMs - this.lastServerLedgerFlushMs >= 10_000
                && Math.abs(this.pendingServerLedger) >= 0.01) {
              const amt = this.pendingServerLedger;
              this.game.economy.recordTransaction(
                amt >= 0 ? "Meal sales & tips" : "Supplies & running costs",
                amt,
              );
              this.pendingServerLedger = 0;
              this.lastServerLedgerFlushMs = nowMs;
            }
          }
        }
        // ── Phase 7.8 — Adopt server-appended cloud_rating_history_csv ──
        // Server's accumulate_pending_visit_rollup appends each
        // freshly-computed visit rating directly to the CSV. The
        // foreground finalizeVisit + applyAngryLeave skip the local
        // recordRating call (Phase 7.8) so this is the only path
        // that drives ratingHistory updates while online. Diff against
        // the old row's CSV to avoid hydrating on unrelated updates.
        const oldCsv = oldRow.cloudRatingHistoryCsv ?? "";
        const newCsv = newRow.cloudRatingHistoryCsv ?? "";
        if (oldCsv !== newCsv && newCsv !== "") {
          const history = newCsv.split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
          this.game.reputation.applyCloudRatingHistory(history);
        }
        // ── Path B — Adopt server-appended cloud_day_history_json ──
        // The server's tick_day_clock is the sole writer of the day
        // history now (one record per rollover, online or offline);
        // the client's DayHistory.push mirror is gated off behind
        // isServerSim. Diff old vs new (same shape as the rating CSV
        // above) so unrelated Restaurant updates don't re-parse the
        // blob. Own try-catch so a malformed blob can't skip the
        // daily-totals adoption below.
        const oldDayHistJson = oldRow.cloudDayHistoryJson ?? "";
        const newDayHistJson = newRow.cloudDayHistoryJson ?? "";
        if (oldDayHistJson !== newDayHistJson && newDayHistJson !== "") {
          try {
            const days = JSON.parse(newDayHistJson);
            if (Array.isArray(days) && days.length > 0) {
              this.game.history.applyCloudSnapshot(days);
            }
          } catch (e) {
            console.warn("[Cloud] day-history adoption failed:", e);
          }
        }
        // ── Phase 7.8 — Adopt cloud daily totals as local truth ──
        // Server bumps cloud_daily_revenue/expenses/served/lost on
        // each despawn (Phase 7.6) + rent/salary/restock events. The
        // foreground client no longer touches local daily totals
        // for visit payouts, so this is how the HUD + leaderboard get
        // their numbers. syncCloudDailyTotals still fires absolute
        // pushes from Engine.update (idempotent server-side when the
        // value matches), but the cloud is canonical here.
        const cloudDailyRevenue = Number(newRow.cloudDailyRevenueCents) / 100;
        if (cloudDailyRevenue !== this.game.economy.getDailyRevenue()) {
          this.game.economy.setDailyRevenue(cloudDailyRevenue);
        }
        const cloudDailyExpenses = Number(newRow.cloudDailyExpensesCents) / 100;
        if (cloudDailyExpenses !== this.game.economy.getDailyExpenses()) {
          this.game.economy.setDailyExpenses(cloudDailyExpenses);
        }
        // Phase 9.54 — today's tips, for the HUD's TIPS card.
        const cloudDailyTips = Number(newRow.cloudDailyTipsCents) / 100;
        if (cloudDailyTips !== this.game.economy.getDailyTips()) {
          this.game.economy.setDailyTips(cloudDailyTips);
        }
        const cloudDailyServed = Number(newRow.cloudDailyServed);
        if (cloudDailyServed !== this.game.customers.getDailyServed()) {
          this.game.customers.setDailyServed(cloudDailyServed);
        }
        const cloudDailyLost = Number(newRow.cloudDailyLost);
        if (cloudDailyLost !== this.game.customers.getDailyLost()) {
          this.game.customers.setDailyLost(cloudDailyLost);
        }
        } catch (e) {
          console.warn("[SpacetimeClient] restaurant.onUpdate handler threw — subscription continues", e);
        }
      });
      ctx.db.co_owner.onInsert(ping);
      ctx.db.co_owner.onDelete(ping);
      // P1+ — auth_record drives sign_up / login completion; without
      // this listener the LoginModal's reducer-call promise times
      // out after 10s waiting for a notify that never fires.
      ctx.db.auth_record.onInsert(ping);
      ctx.db.auth_record.onUpdate(ping);
      ctx.db.auth_record.onDelete(ping);
      // P7 admin panel — ban_record + password_reset_request feed the
      // admin's "pending tickets" and "banned players" lists. Without
      // these listeners those sections wouldn't refresh after the
      // admin issues a ban / unban / reset.
      ctx.db.ban_record.onInsert(ping);
      ctx.db.ban_record.onUpdate(ping);
      ctx.db.ban_record.onDelete(ping);
      ctx.db.password_reset_request.onInsert(ping);
      ctx.db.password_reset_request.onUpdate(ping);
      ctx.db.password_reset_request.onDelete(ping);
      // Global weather — server's periodic weather_roll updates the
      // single weather_state row; clients re-render the rain / snow
      // / festival visuals + the HUD weather chip in response.
      ctx.db.weather_state.onInsert(ping);
      ctx.db.weather_state.onUpdate(ping);
      // P8 chat — drive ChatPanel live re-render on every new
      // message. Insert fires for both sent and received messages;
      // the panel filters by active channel and tracks unread
      // counts for inactive tabs.
      ctx.db.chat_message.onInsert((_evCtx, row) => {
        ping();
        for (const cb of this.chatMessageListeners) {
          try {
            cb({
              id: row.id,
              channel: row.channel,
              senderHex: row.sender.toHexString(),
              senderName: this.displayNameFor(row.sender.toHexString()),
              text: row.text,
              sentAtMs: Number((row.sentAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0)) / 1000,
              isMine: this.identity ? identityEquals(row.sender, this.identity) : false,
            });
          } catch { /* ignore */ }
        }
      });
      ctx.db.chat_message.onDelete(ping);
      // P2+ — building rows feed BuildingPickModal's live refresh
      // and Engine.refreshCityBuildings.
      ctx.db.building.onInsert(ping);
      ctx.db.building.onUpdate(ping);
      // P4 visit mode — when another player publishes a save, any
      // open visit overlay needs to refresh.
      ctx.db.player_save.onInsert(ping);
      ctx.db.player_save.onUpdate(ping);
      // P5 — pedestrian inserts/deletes drive the SharedPedestrians
      // renderer's add/remove of character models. Position updates
      // happen client-side via lerp; the server only spawns + despawns.
      ctx.db.pedestrian.onInsert(ping);
      ctx.db.pedestrian.onDelete(ping);
      // P5.8 — visit-event inserts trigger the host's toast. We
      // filter to events where host == self inside the listener so
      // other players' visit activity stays quiet (and we don't
      // spam Bob's screen with "Alice visited Carol").
      ctx.db.visit_event.onInsert((_evCtx, row) => {
        ping();
        const me = this.identity;
        if (!me) return;
        if (row.host.toHexString() !== me.toHexString()) return;
        for (const cb of this.visitListeners) {
          try { cb(row.visitor.toHexString()); } catch { /* ignore */ }
        }
      });
    } catch (e) {
      // The SDK's onInsert/etc. names occasionally vary by codegen version.
      // Failing to wire just means no live updates — manual refreshes still work.
      console.warn("[SpacetimeDB] couldn't wire live listeners:", e);
    }
  }

  /** Hook Game / SaveSystem events to mirror them into the DB. */
  private wireGameHooks(): void {
    // Phase H.64 — REMOVED: was scheduling a cloud save_snapshot
    // upload on every local autosave tick (every 5 s).  Now that
    // every gameplay field has its own per-table cloud mirror
    // (H.31-H.63), the JSON blob is only useful for visit mode's
    // read path — and a once-per-day-rollover + beforeunload upload
    // is more than enough for that.  Local IndexedDB autosave still
    // runs at its own cadence; this just stops the cloud upload
    // piggyback.

    // 2) Achievement unlocks → reducer (idempotent server-side).
    const originalUnlock = this.game.achievements.onUnlock;
    this.game.achievements.onUnlock = (a) => {
      originalUnlock?.(a);
      this.conn?.reducers.unlockAchievement({ achievementId: a.id });
    };

    // 3) End-of-day → submit_leaderboard for each category +
    //    push the save_snapshot blob.  Day rollover is a natural
    //    consolidation point: low frequency (1 / 12 real-min game
    //    day) and a coherent moment for visit-mode subscribers
    //    to pick up the new state.  This + the beforeunload path
    //    are the only two places save_snapshot is uploaded now.
    const originalDayEnd = this.game.onDayEnded;
    this.game.onDayEnded = (s) => {
      originalDayEnd?.(s);
      if (this.restaurantId == null || !this.conn) return;
      const rid = this.restaurantId;
      this.conn.reducers.submitLeaderboard({
        restaurantId: rid, category: "daily_revenue",
        score: BigInt(Math.max(0, Math.round(s.revenue))),
        dayNumber: s.dayNumber,
      });
      this.conn.reducers.submitLeaderboard({
        restaurantId: rid, category: "daily_served",
        score: BigInt(Math.max(0, s.served)),
        dayNumber: s.dayNumber,
      });
      // H.64 — consolidate the day's state into the visit-mode blob.
      // Visit mode reads player_save; no other path needs the
      // save_snapshot upsert.
      this.cloudSaveNow();
    };
  }

  // Phase H.64 — REMOVED: scheduleCloudSave was the per-autosave-tick
  // throttle for cloud save_snapshot uploads.  All gameplay fields
  // are now mirrored to dedicated cloud tables (H.31-H.63), so the
  // JSON blob is upload only at day rollover + beforeunload via
  // explicit cloudSaveNow() calls.  No need for a throttle.

  /** Push the current game state to the save_snapshot table. Skips if
   * we don't have an authoritative restaurantId yet.
   *
   * Also publishes to the per-identity `player_save` table so P4 visit
   * mode has a single canonical save per account that other players
   * can subscribe to without going through Restaurant.id indirection.
   * The legacy save_snapshot upsert stays for the multi-restaurant
   * future; player_save is the one the visit code reads from. */
  cloudSaveNow(): void {
    if (!this.conn) return;
    // Snapshot must run on the main thread (touches live Game state),
    // but the heavy stringify goes to the save worker. publishCloud is
    // the tail that runs once the JSON is back — reducer call + per-
    // identity publish. Fire-and-forget; nothing here awaits.
    let state: SaveGameState;
    try {
      state = this.saver.snapshotForCloud();
    } catch (e) {
      console.warn("[SpacetimeDB] cloud snapshot failed", e);
      return;
    }
    this.saver.serializeAsync(state).then(
      (json) => this.publishCloud(json),
      (e) => console.warn("[SpacetimeDB] cloud serialize failed", e),
    );
  }

  /** Tail of {@link cloudSaveNow} — runs once the worker hands the JSON
   * string back. Skips the upload if it's too large, otherwise pushes
   * to the legacy restaurant-keyed table (if we have an id) AND the
   * per-identity player_save table (visit mode reads this one). */
  private publishCloud(json: string): void {
    if (!this.conn) return;
    // Cross-device DATA-LOSS GUARD — a FRESH-START session that has NOT loaded
    // a cloud save must never overwrite an EXISTING cloud save with MORE
    // progress. The race: we booted fresh (incognito / new device) before the
    // login reducer transferred the restaurant + player_save to us, so the real
    // tier-5 save never loaded and we're running a day-1 shell. A day-rollover
    // or tab-close cloudSaveNow would then write that shell over the real save —
    // exactly the "InPrivate shows tier 1" report. Block the write, and pull the
    // real save instead (reloads into it when the tab isn't already closing).
    if (this.wasFreshStart && !this.cloudAutoLoadTriggered && this.identity) {
      const existing = this.getCanonicalSave();
      if (existing && existing.data) {
        const curDay = this.game.day.getDayNumber();
        const curTier = this.game.getLuxuryTier();
        if (existing.dayNumber > curDay || existing.luxuryTier > curTier) {
          console.warn(`[SpacetimeDB] BLOCKED cloud save: fresh shell (day ${curDay}/tier ${curTier}) would regress cloud save (day ${existing.dayNumber}/tier ${existing.luxuryTier}). Pulling the real save instead.`);
          this.maybeAutoLoadCloudSave({ data: existing.data });
          return;
        }
      }
    }
    try {
      if (json.length > 256 * 1024) {
        console.warn(`[SpacetimeDB] save too large to upload (${json.length} bytes)`);
        return;
      }
      // Legacy restaurant-keyed upsert (only when we have a restaurantId).
      if (this.restaurantId != null) {
        this.conn.reducers.saveRestaurantSnapshot({
          restaurantId: this.restaurantId,
          data: json,
          dayNumber: this.game.day.getDayNumber(),
          money: BigInt(Math.round(this.game.economy.getMoney())),
          ratingAvg: this.game.reputation.getAverageRating(),
          luxuryTier: this.game.getLuxuryTier(),
        });
      }
      // P4 — per-identity publish that visit mode subscribes to.
      // Independent of restaurantId so even pre-restaurant accounts
      // (e.g. mid signup) get their state synced as soon as they
      // start autosaving. P5.7 adds restaurantOpen + freeSeats so
      // the attraction layer can skip closed / full plots.
      const spawnerStats = this.cloudSpawnerHook?.();
      this.publishPlayerSave(
        json,
        this.game.day.getDayNumber(),
        this.game.economy.getMoney(),
        this.game.reputation.getAverageRating(),
        this.game.getLuxuryTier(),
        spawnerStats?.open ?? true,
        spawnerStats?.freeSeats ?? 0,
      );
      // Phase J — also write the ACCOUNT-keyed canonical save (stable across
      // devices/sessions). Best-effort; the server accepts it only from the
      // account's active session.
      this.saveAccount(
        json,
        this.game.day.getDayNumber(),
        this.game.economy.getMoney(),
        this.game.reputation.getAverageRating(),
        this.game.getLuxuryTier(),
      );
    } catch (e) {
      console.warn("[SpacetimeDB] cloud save failed", e);
    }
  }

  /** Latest cloud save snapshot summary, or null if none / not connected.
   * Used by SlotsModal to render the "Load from cloud" button. */
  getCloudSummary(): { dayNumber: number; money: number; ratingAvg: number; luxuryTier: number; savedAtMs: number } | null {
    if (!this.conn || this.restaurantId == null) return null;
    try {
      const snap = this.conn.db.save_snapshot.restaurant_id.find(this.restaurantId);
      if (!snap) return null;
      return {
        dayNumber: snap.dayNumber,
        money: Number(snap.money),
        ratingAvg: snap.ratingAvg,
        luxuryTier: snap.luxuryTier,
        savedAtMs: Number(snap.savedAt?.microsSinceUnixEpoch ?? 0n) / 1000,
      };
    } catch {
      return null;
    }
  }

  /** Pull the cloud snapshot's full payload (JSON-stringified SaveGameState).
   * Caller is responsible for parsing + handing to Engine.hydrate / reload. */
  getCloudSavePayload(): string | null {
    if (!this.conn || this.restaurantId == null) return null;
    try {
      const snap = this.conn.db.save_snapshot.restaurant_id.find(this.restaurantId);
      return snap?.data ?? null;
    } catch {
      return null;
    }
  }

  /** True once we've connected and subscribed; tells UI panels whether to
   * render data or show a "connecting…" placeholder. */
  isReady(): boolean { return this.wired && this.conn != null; }

  /** Register a callback that fires when relevant tables mutate. Returns
   * an unsubscribe fn. UI panels use this to live-refresh. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch (e) { console.warn("[SpacetimeDB] listener threw", e); }
    }
  }

  /** Lookup a player row's display name by Identity hex. Falls back to
   * a shortened hex if the player has no row yet. */
  private nameFor(hex: string): string {
    if (!this.conn) return shortHex(hex);
    for (const p of this.conn.db.player.iter()) {
      if (p.identity.toHexString() === hex) return p.name || shortHex(hex);
    }
    return shortHex(hex);
  }

  /** Get the current player's display name (empty string if none set). */
  getMyName(): string {
    if (!this.conn || !this.identity) return "";
    const me = this.identity.toHexString();
    for (const p of this.conn.db.player.iter()) {
      if (p.identity.toHexString() === me) return p.name;
    }
    return "";
  }

  /** Get my identity hex for UI display. */
  getMyHex(): string { return this.identity?.toHexString() ?? ""; }

  /** Push a new display name via the set_player_name reducer. */
  setMyName(name: string): void {
    if (!this.conn) return;
    const trimmed = name.trim().slice(0, 32);
    if (trimmed.length === 0) return;
    this.conn.reducers.setPlayerName({ name: trimmed });
  }

  /** Top N rows of a leaderboard category, sorted desc by score. */
  getLeaderboard(category: string, limit = 25): LeaderboardRow[] {
    if (!this.conn) return [];
    const rows = Array.from(this.conn.db.leaderboard_entry.iter())
      .filter((r) => r.category === category)
      .sort((a, b) => Number(b.score - a.score));
    const me = this.identity?.toHexString() ?? "";
    return rows.slice(0, limit).map((r, i) => {
      const hex = r.player.toHexString();
      return {
        rank: i + 1,
        playerHex: hex,
        playerName: this.nameFor(hex),
        score: Number(r.score),
        dayNumber: r.dayNumber,
        isMe: hex === me,
      };
    });
  }

  /** Friend list + pending requests in/out for the current player. */
  getFriendsView(): FriendsView {
    const empty: FriendsView = { friends: [], incoming: [], outgoing: [] };
    if (!this.conn || !this.identity) return empty;
    const meHex = this.identity.toHexString();
    const friends: { hex: string; name: string }[] = [];
    for (const f of this.conn.db.friendship.iter()) {
      const aHex = f.playerA.toHexString();
      const bHex = f.playerB.toHexString();
      if (aHex === meHex) friends.push({ hex: bHex, name: this.nameFor(bHex) });
      else if (bHex === meHex) friends.push({ hex: aHex, name: this.nameFor(aHex) });
    }
    const incoming: FriendsView["incoming"] = [];
    const outgoing: FriendsView["outgoing"] = [];
    for (const r of this.conn.db.friend_request.iter()) {
      if (r.status !== "pending") continue;
      const fromHex = r.fromPlayer.toHexString();
      const toHex = r.toPlayer.toHexString();
      if (toHex === meHex) {
        incoming.push({ requestId: r.id, fromHex, fromName: this.nameFor(fromHex) });
      } else if (fromHex === meHex) {
        outgoing.push({ requestId: r.id, toHex, toName: this.nameFor(toHex) });
      }
    }
    return { friends, incoming, outgoing };
  }

  sendFriendRequestByHex(targetHex: string): void {
    if (!this.conn || !this.identity) return;
    const target = parseHexToIdentity(targetHex);
    if (!target) return;
    this.conn.reducers.sendFriendRequest({ target });
  }

  respondFriendRequest(requestId: bigint, accept: boolean): void {
    this.conn?.reducers.respondFriendRequest({ requestId, accept });
  }

  unfriendByHex(otherHex: string): void {
    if (!this.conn) return;
    const other = parseHexToIdentity(otherHex);
    if (!other) return;
    this.conn.reducers.unfriend({ other });
  }

  /** All active_guest rows in the local subscription cache, regardless
   * of which restaurant they belong to. Tagged with restaurantId so
   * the caller can filter. Same role as listAllStaffActors but for
   * the customer table — used by VisitMode + diagnostic helpers. */
  listAllActiveGuests(): { restaurantId: bigint; row: ActiveGuestRow }[] {
    if (!this.conn) return [];
    const out: { restaurantId: bigint; row: ActiveGuestRow }[] = [];
    try {
      for (const g of this.conn.db.active_guest.iter()) {
        out.push({
          restaurantId: g.restaurantId,
          row: {
            id: g.id, state: g.state, variant: g.variant, archetype: g.archetype,
            patienceMs: g.patienceMs,
            x: g.x, z: g.z, floor: g.floor,
            targetX: g.targetX, targetZ: g.targetZ, targetFloor: g.targetFloor,
            seatUid: g.seatUid,
            seatX: g.seatX, seatZ: g.seatZ, seatFloor: g.seatFloor,
            plateX: g.plateX, plateZ: g.plateZ,
            orderIndex: g.orderIndex,
            orderRecipes: g.orderRecipes,
          },
        });
      }
    } catch { /* table not wired */ }
    return out;
  }

  /** All active_ticket rows in the local subscription cache, regardless
   * of which restaurant. Tagged for filtering. */
  listAllActiveTickets(): { restaurantId: bigint; row: ActiveTicketRow }[] {
    if (!this.conn) return [];
    const out: { restaurantId: bigint; row: ActiveTicketRow }[] = [];
    try {
      for (const t of this.conn.db.active_ticket.iter()) {
        out.push({
          restaurantId: t.restaurantId,
          row: {
            id: t.id, clientTempId: t.clientTempId, guestId: t.guestId,
            recipeId: t.recipeId, state: t.state, stateClockMs: t.stateClockMs,
            cookSeconds: t.cookSecondsMs, assignedChefId: t.assignedChefId,
            seatX: t.seatX, seatZ: t.seatZ, seatFloor: t.seatFloor, seatAtBar: t.seatAtBar,
            pickupX: t.pickupX, pickupZ: t.pickupZ, pickupFloor: t.pickupFloor,
            appliance: t.appliance,
          },
        });
      }
    } catch { /* table not wired */ }
    return out;
  }

  /** All staff_actor rows in the local subscription cache, regardless
   * of which restaurant they belong to. Used by VisitMode + dev
   * diagnostics that need to inspect another host's staff state.
   * Returns the row with its restaurantId tagged so the caller can
   * filter for the host they care about. */
  listAllStaffActors(): { restaurantId: bigint; row: StaffActorRow }[] {
    if (!this.conn) return [];
    const out: { restaurantId: bigint; row: StaffActorRow }[] = [];
    try {
      for (const a of this.conn.db.staff_actor.iter()) {
        out.push({
          restaurantId: a.restaurantId,
          row: {
            memberId: a.memberId, role: a.role, state: a.state,
            x: a.x, z: a.z, floor: a.floor,
            targetX: a.targetX, targetZ: a.targetZ, targetFloor: a.targetFloor,
            faceY: a.faceY,
            ticketId: a.ticketId ?? null,
            assignedStoveUid: a.assignedStoveUid,
            washTargetUid: a.washTargetUid,
            washPhase: a.washPhase,
            takeOrderGuestId: a.takeOrderGuestId ?? null,
            errandPhase: a.errandPhase ?? null,
            cleanSeatUid: a.cleanSeatUid ?? null,
          },
        });
      }
    } catch { /* table not wired yet */ }
    return out;
  }

  /** Map of member_id → the server's CURRENT home_floor for every
   * staff_actor in the subscription cache. The client (StaffSystem)
   * is the source of truth for floor assignment, but the server's row
   * can drift stale if a re-register was ever missed (e.g. a pre-9.55
   * assignment, or a dropped reducer call). StaffRouter's home_floor
   * self-heal (Phase 9.59) reads this every ~1 s and re-pushes any
   * idle actor whose server floor no longer matches the player's
   * assignment, so the strict per-floor dispatch always uses the
   * floors the player actually set. */
  getServerHomeFloorMap(): Map<string, number> {
    const m = new Map<string, number>();
    if (!this.conn) return m;
    try {
      for (const a of this.conn.db.staff_actor.iter()) {
        m.set(a.memberId, a.homeFloor);
      }
    } catch { /* table not wired yet */ }
    return m;
  }

  // ── Phase 2 — server-truth readouts for StaffPanel + HUD ──────────
  // The local StaffRouter sim renders the server's dispatch decisions but
  // re-derives its own timing, so its actors drift idle-looking the longer
  // a session runs (the "staff look idle but the server has them working"
  // bug). These read the SERVER's staff_actor + active_ticket — the
  // authority — and return null when the cloud / subscription / flag isn't
  // ready so the caller falls back to the local sim.

  /** Members of `role` the SERVER counts as busy (state != "idle"). Only
   * chef/waiter/barman are server-authoritative (errand is still a local
   * sim) → null for anything else so the local count stands. */
  getServerStaffWorkingCount(role: string): number | null {
    if (role !== "chef" && role !== "waiter" && role !== "barman") return null;
    if (!isServerSim("staff") || !this.conn || this.restaurantId == null) return null;
    const rid = this.restaurantId;
    try {
      let n = 0;
      for (const a of this.conn.db.staff_actor.iter()) {
        if (a.restaurantId !== rid || a.role !== role) continue;
        if (a.state !== "idle") n += 1;
      }
      return n;
    } catch { return null; }
  }

  /** Ticket-state tallies for my restaurant, mapped to the panel's
   * vocabulary (the server says waitingChef / pickedUp where the panel
   * says queued / delivering). */
  getServerTicketStats(): { queued: number; cooking: number; ready: number; delivering: number } | null {
    if (!isServerSim("tickets") || !this.conn || this.restaurantId == null) return null;
    const rid = this.restaurantId;
    try {
      let queued = 0, cooking = 0, ready = 0, delivering = 0;
      for (const t of this.conn.db.active_ticket.iter()) {
        if (t.restaurantId !== rid) continue;
        switch (t.state) {
          case "queued": case "waitingChef": queued += 1; break;
          case "cooking": cooking += 1; break;
          case "ready": ready += 1; break;
          case "delivering": case "pickedUp": delivering += 1; break;
        }
      }
      return { queued, cooking, ready, delivering };
    } catch { return null; }
  }

  /** A chef's in-flight cook load (non-bar tickets the server has on
   * them). Returns 0 legitimately when they hold none; null only when the
   * cloud isn't ready. */
  getServerChefBacklog(memberId: string): number | null {
    return this.serverCookBacklog(memberId, false);
  }

  /** A barman's in-flight load (bar tickets on them). */
  getServerBarmanBacklog(memberId: string): number | null {
    return this.serverCookBacklog(memberId, true);
  }

  private serverCookBacklog(memberId: string, bar: boolean): number | null {
    if (!isServerSim("tickets") || !this.conn || this.restaurantId == null) return null;
    const rid = this.restaurantId;
    try {
      let n = 0;
      for (const t of this.conn.db.active_ticket.iter()) {
        if (t.restaurantId !== rid || t.assignedChefId !== memberId) continue;
        if (bar !== (t.appliance === "bar")) continue;
        if (t.state === "queued" || t.state === "waitingChef" || t.state === "cooking") n += 1;
      }
      return n;
    } catch { return null; }
  }

  /** A waiter's concurrent task count straight off their staff_actor row:
   * a delivery ticket + a take-order + a wash trip (max 3). Null when not
   * registered server-side → local fallback. */
  getServerWaiterBacklog(memberId: string): number | null {
    if (!isServerSim("staff") || !this.conn || this.restaurantId == null) return null;
    const rid = this.restaurantId;
    try {
      for (const a of this.conn.db.staff_actor.iter()) {
        if (a.restaurantId !== rid || a.memberId !== memberId) continue;
        let n = 0;
        if (a.ticketId != null) n += 1;
        if (a.takeOrderGuestId != null) n += 1;
        if (a.washTargetUid && a.washTargetUid !== "") n += 1;
        return n;
      }
      return null;
    } catch { return null; }
  }

  /** Find the restaurant_id that belongs to the given owner identity
   * (passed as a hex string). Used by VisitMode to wire live-state
   * subscriptions on the visited host's rid. Returns null when no
   * restaurant exists for that owner — the visited player may have
   * been deleted, or the subscription cache may not have hydrated yet.
   *
   * Each player owns exactly one restaurant (P2 building claim
   * enforces this), so the first match wins. */
  findRestaurantIdByOwnerHex(ownerHex: string): bigint | null {
    if (!this.conn) return null;
    const target = ownerHex.toLowerCase();
    try {
      for (const r of this.conn.db.restaurant.iter()) {
        if (r.owner.toHexString().toLowerCase() === target) return r.id;
      }
    } catch { /* table not wired yet */ }
    return null;
  }

  /** Visit-mode rating-sign parity — read the visited restaurant's
   * display name from the subscribed Restaurant row. Returns null
   * when the row isn't yet subscribed. */
  getRestaurantNameByOwnerHex(ownerHex: string): string | null {
    if (!this.conn) return null;
    const target = ownerHex.toLowerCase();
    try {
      for (const r of this.conn.db.restaurant.iter()) {
        if (r.owner.toHexString().toLowerCase() === target) return r.name ?? null;
      }
    } catch { /* table not wired yet */ }
    return null;
  }

  /** Visit-mode theme parity — read the visited restaurant's
   * per-floor theme override CSV from the subscribed Restaurant row.
   * Empty / null when the host hasn't customised any floor (visit
   * mode falls back to the catalog default in that case). Format:
   * "storey:theme_id|storey:theme_id". */
  getRestaurantThemeOverridesByOwnerHex(ownerHex: string): string | null {
    if (!this.conn) return null;
    const target = ownerHex.toLowerCase();
    try {
      for (const r of this.conn.db.restaurant.iter()) {
        if (r.owner.toHexString().toLowerCase() !== target) continue;
        return r.themeOverridesCsv ?? null;
      }
    } catch { /* table not wired yet */ }
    return null;
  }

  /** Restaurants visible to me — mine, public, and ones I co-own. */
  getRestaurants(): RestaurantRow[] {
    if (!this.conn) return [];
    const meHex = this.identity?.toHexString() ?? "";
    // Restaurants I co-own (lookup by player identity).
    const coOwnedIds = new Set<string>();
    for (const co of this.conn.db.co_owner.iter()) {
      if (co.player.toHexString() === meHex) coOwnedIds.add(String(co.restaurantId));
    }
    const out: RestaurantRow[] = [];
    for (const r of this.conn.db.restaurant.iter()) {
      const ownerHex = r.owner.toHexString();
      const isMine = ownerHex === meHex;
      const isCo = coOwnedIds.has(String(r.id));
      if (!isMine && !isCo && !r.public) continue;
      out.push({
        id: r.id,
        name: r.name,
        ownerHex,
        ownerName: this.nameFor(ownerHex),
        isPublic: r.public,
        isMine,
        isCoOwner: isCo,
      });
    }
    return out.sort((a, b) => {
      // Mine first, then co-owned, then public.
      const rank = (row: RestaurantRow) => (row.isMine ? 0 : row.isCoOwner ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
  }

  setRestaurantPublic(restaurantId: bigint, isPublic: boolean): void {
    this.conn?.reducers.setRestaurantPublic({ restaurantId, public: isPublic });
  }

  inviteCoOwnerByHex(restaurantId: bigint, playerHex: string): void {
    if (!this.conn) return;
    const friend = parseHexToIdentity(playerHex);
    if (!friend) return;
    this.conn.reducers.inviteCoOwner({ restaurantId, friend });
  }

  removeCoOwnerByHex(restaurantId: bigint, playerHex: string): void {
    if (!this.conn) return;
    const playerToRemove = parseHexToIdentity(playerHex);
    if (!playerToRemove) return;
    this.conn.reducers.removeCoOwner({ restaurantId, playerToRemove });
  }

  /** Disconnect cleanly (called on page unload). */
  disconnect(): void {
    if (this.saveDebounce != null) {
      window.clearTimeout(this.saveDebounce);
      this.saveDebounce = null;
    }
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.conn?.disconnect();
    this.conn = null;
  }

  /** Current global weather kind ("sunny", "cloudy", "rainy",
   * "heavy-rain", "festival", "cold", "snowy"). Reads from the
   * server-side weather_state row maintained by the periodic
   * weather_roll reducer. Returns null when the cache hasn't
   * landed yet — callers fall back to "sunny" or whatever local
   * default makes sense. */
  getCurrentWeatherKind(): string | null {
    if (!this.conn) return null;
    try {
      const row = this.conn.db.weather_state.id.find(1);
      return row?.kind ?? null;
    } catch { return null; }
  }

  /** Admin-only — force the global weather to the given kind. The
   * AdminModal weather preview buttons call this so the admin can
   * try rain / snow / festival without waiting for the next
   * 8-minute roll. Non-admins get rejected by the reducer. */
  adminSetWeather(kind: string): Promise<void> {
    return this.callReducer("adminSetWeather", () =>
      this.conn!.reducers.adminSetWeather({ kind }));
  }

  /** Count players whose last_seen_at falls within the online window
   * (~90 s — 3× the heartbeat cadence to tolerate a couple of missed
   * pings before someone drops from the count). */
  countOnlinePlayers(): number {
    if (!this.conn) return 0;
    const ONLINE_WINDOW_MS = 90_000;
    const cutoffMs = Date.now() - ONLINE_WINDOW_MS;
    let count = 0;
    try {
      for (const p of this.conn.db.player.iter()) {
        const tsMicros = Number((p.lastSeenAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0));
        const tsMs = tsMicros / 1000;
        if (tsMs >= cutoffMs) count += 1;
      }
    } catch { /* ignore */ }
    return count;
  }

  /** Full roster: every account on the server with an online flag
   * derived from the player table's last_seen_at (same 90 s window
   * as countOnlinePlayers). Sorted online-first, then alphabetical
   * within each section — drives the PlayerRosterPanel. */
  getPlayerRoster(): Array<{ username: string; displayName: string; isOnline: boolean; isMe: boolean; isAdmin: boolean }> {
    if (!this.conn) return [];
    const ONLINE_WINDOW_MS = 90_000;
    const cutoffMs = Date.now() - ONLINE_WINDOW_MS;
    // Build a quick "identity hex → online" lookup from the player
    // table so the auth_record loop below doesn't pay O(P) per row.
    const onlineHex = new Set<string>();
    try {
      for (const p of this.conn.db.player.iter()) {
        const tsMicros = Number((p.lastSeenAt as unknown as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ ?? BigInt(0));
        const tsMs = tsMicros / 1000;
        if (tsMs >= cutoffMs) onlineHex.add(p.identity.toHexString().toLowerCase());
      }
    } catch { /* ignore */ }
    const meHex = this.identity?.toHexString().toLowerCase() ?? "";
    const rows: Array<{ username: string; displayName: string; isOnline: boolean; isMe: boolean; isAdmin: boolean }> = [];
    try {
      for (const a of this.conn.db.auth_record.iter()) {
        if (!a.username) continue;
        const hex = a.identity.toHexString().toLowerCase();
        rows.push({
          username: a.username,
          displayName: a.displayName || a.username,
          isOnline: onlineHex.has(hex),
          isMe: hex === meHex,
          isAdmin: a.isAdmin,
        });
      }
    } catch { /* not wired yet */ }
    // Online first, then offline; alphabetical (by display name,
    // case-insensitive) within each section.
    rows.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
    });
    return rows;
  }
}

/** Identity equality helper. The runtime Identity class doesn't always
 * expose `.isEqual`, but `.toHexString()` is reliable. */
function identityEquals(a: Identity, b: Identity): boolean {
  return a.toHexString() === b.toHexString();
}

/** Shorten an identity hex for display when no display name is set. */
function shortHex(hex: string): string {
  if (!hex) return "(unknown)";
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

/** Parse a 64-char hex string back into an Identity. Returns null on a bad
 * input so the UI can surface a friendly error rather than crashing. */
function parseHexToIdentity(hex: string): Identity | null {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(clean) || clean.length === 0) return null;
  try {
    // The SDK ships Identity.fromString which accepts a hex. If it isn't
    // available in this version we fall back to null.
    const idCtor = (Identity as unknown as { fromString?: (s: string) => Identity });
    if (typeof idCtor.fromString === "function") return idCtor.fromString(clean);
    return null;
  } catch {
    return null;
  }
}
