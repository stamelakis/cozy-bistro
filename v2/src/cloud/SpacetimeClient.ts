/**
 * Bridge between the Cozy Bistro 3D Game/Engine and the
 * SpacetimeDB-published `cozy-bistro-andre` module.
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

/** Public shape of one dishwasher_batch row — mid-cycle state for one
 * placed dishwasher (keyed by furnitureUid). cycleTimeRemainingMs is
 * the milliseconds left until the batch flushes to the clean pool. */
export interface DishwasherBatchRow {
  furnitureUid: string;
  defId: string;
  plates: number;
  glasses: number;
  cycleTimeRemainingMs: bigint;
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
  ticketId: bigint | null;
  assignedStoveUid: string;
  washTargetUid: string;
  washPhase: string;
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
}
import { DbConnection, type SubscriptionEventContext, type ErrorContext } from "./generated";
import { Identity } from "spacetimedb";

const TOKEN_KEY = "cozy-bistro-stdb-token";
const DEFAULT_HOST = "wss://maincloud.spacetimedb.com";
const DEFAULT_MODULE = "cozy-bistro-andre";

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
  private maybeAutoLoadCloudSave(snap: { data: string } | null): void {
    if (this.cloudAutoLoadTriggered) return;
    if (!this.wasFreshStart) return;
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
    try {
      localStorage.setItem(key, snap.data);
    } catch (e) {
      console.warn("[SpacetimeDB] couldn't write cloud save to localStorage (quota?)", e);
      return;
    }
    this.cloudAutoLoadTriggered = true;
    console.log(`[SpacetimeDB] cross-device login — auto-loaded cloud save into slot ${slot}, reloading`);
    // Tiny delay so the console message can flush + so the user
    // sees a brief "loading…" before the page swaps. The reload
    // re-enters Engine boot, which now finds the save in
    // localStorage and hydrates as if it were a normal returning
    // player.
    window.setTimeout(() => window.location.reload(), 250);
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
   * Returns [] when not connected or when no restaurant is known yet. */
  listActiveGuests(): {
    id: bigint;
    clientTempId: string;
    state: string;
    variant: string;
    archetype: string;
    stateClockMs: bigint;
    patienceMs: bigint;
    x: number;
    z: number;
    floor: number;
    targetX: number;
    targetZ: number;
    targetFloor: number;
    seatUid: string;
  }[] {
    if (!this.conn || this.restaurantId == null) return [];
    const out: ReturnType<SpacetimeClient["listActiveGuests"]> = [];
    const rid = this.restaurantId;
    try {
      for (const g of this.conn.db.active_guest.iter()) {
        if (g.restaurantId !== rid) continue;
        out.push({
          id: g.id,
          clientTempId: g.clientTempId,
          state: g.state,
          variant: g.variant,
          archetype: g.archetype,
          stateClockMs: g.stateClockMs,
          patienceMs: g.patienceMs,
          x: g.x,
          z: g.z,
          floor: g.floor,
          targetX: g.targetX,
          targetZ: g.targetZ,
          targetFloor: g.targetFloor,
          seatUid: g.seatUid,
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

  /** Stream body position + next target up to the server. Called by
   * GuestSpawner's per-frame walker — throttled to ~5 Hz by the
   * caller. Targets feed any future "render this guest from another
   * client's view" path (P4 visit mode + co-owner mirroring). */
  updateGuestPosition(guestId: bigint, x: number, z: number, floor: number,
                      targetX: number, targetZ: number, targetFloor: number): void {
    if (!this.conn) return;
    try {
      this.conn.reducers.updateGuestPosition({
        guestId, x, z, floor, targetX, targetZ, targetFloor,
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
  listActiveTickets(): {
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
  }[] {
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
          ticketId: a.ticketId ?? null,
          assignedStoveUid: a.assignedStoveUid,
          washTargetUid: a.washTargetUid,
          washPhase: a.washPhase,
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
      ticketId: bigint | undefined;
      assignedStoveUid: string; washTargetUid: string; washPhase: string;
    };
    const toClientRow = (r: ServerRow): StaffActorRow => ({
      memberId: r.memberId, role: r.role, state: r.state,
      x: r.x, z: r.z, floor: r.floor,
      targetX: r.targetX, targetZ: r.targetZ, targetFloor: r.targetFloor,
      ticketId: r.ticketId ?? null,
      assignedStoveUid: r.assignedStoveUid,
      washTargetUid: r.washTargetUid,
      washPhase: r.washPhase,
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
    };
    const toClientRow = (r: ServerRow): ActiveTicketRow => ({
      id: r.id, clientTempId: r.clientTempId, guestId: r.guestId,
      recipeId: r.recipeId, state: r.state, stateClockMs: r.stateClockMs,
      cookSeconds: r.cookSecondsMs, assignedChefId: r.assignedChefId,
      seatX: r.seatX, seatZ: r.seatZ, seatFloor: r.seatFloor, seatAtBar: r.seatAtBar,
      pickupX: r.pickupX, pickupZ: r.pickupZ, pickupFloor: r.pickupFloor,
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
    type ServerRow = { furnitureUid: string; restaurantId: bigint; defId: string; plates: number; glasses: number; cycleTimeRemainingMs: bigint };
    const toClientRow = (r: ServerRow): DishwasherBatchRow => ({
      furnitureUid: r.furnitureUid,
      defId: r.defId,
      plates: r.plates,
      glasses: r.glasses,
      cycleTimeRemainingMs: r.cycleTimeRemainingMs,
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

  /** Upsert one dishwasher's mid-cycle state. */
  updateDishwasherBatch(furnitureUid: string, defId: string, plates: number, glasses: number, cycleTimeRemainingMs: bigint): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      this.conn.reducers.updateDishwasherBatch({
        restaurantId: this.restaurantId,
        furnitureUid, defId, plates, glasses, cycleTimeRemainingMs,
      });
    } catch (e) {
      console.warn("[Cloud] updateDishwasherBatch failed:", e);
    }
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
  signUp(username: string, password: string, rememberMe = true): Promise<void> {
    this.setRememberMe(rememberMe);
    return this.callReducer("signUp", () => this.conn!.reducers.signUp({ username, password }));
  }

  /** Call login. Resolves on success, rejects with the reducer's
   * error string (e.g. "Wrong password"). `rememberMe` controls
   * whether the identity token is stored in localStorage (true,
   * default — survives browser restart) or sessionStorage (false —
   * cleared on tab close). */
  login(username: string, password: string, rememberMe = true): Promise<void> {
    this.setRememberMe(rememberMe);
    return this.callReducer("login", () => this.conn!.reducers.login({ username, password }));
  }

  /** Call logout. Releases this identity's claim on the account so
   * the row can be re-claimed via a fresh login. */
  logout(): Promise<void> {
    return this.callReducer("logout", () => this.conn!.reducers.logout({}));
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

  /** Wait for one reducer call to apply OR fail. SpacetimeDB
   * reducers fire-and-forget; we wire transient onSuccess /
   * onError listeners to convert that into a Promise the modal
   * can `await`. Times out after 10s so a dropped connection
   * doesn't hang the UI forever. */
  private callReducer(_label: string, fire: () => void): Promise<void> {
    if (!this.conn) return Promise.reject(new Error("Not connected"));
    // Subscribing to a reducer's events is SDK-specific and noisy.
    // Easier path: kick off the call, then poll the local cache /
    // listen for a state change for a short window. For auth flows
    // we care about the OUTCOME visible in the cache (auth_record
    // row appears/updates) rather than the literal reducer ACK,
    // so listening for a notify is good enough.
    return new Promise((resolve, reject) => {
      const t = window.setTimeout(() => {
        cleanup();
        reject(new Error("Server didn't respond in time"));
      }, 10_000);
      const cleanup = (): void => {
        window.clearTimeout(t);
        this.listeners.delete(onChange);
      };
      const onChange = (): void => {
        // Resolve on the next state mutation. The modal calls
        // getCurrentAccount() after the resolve to verify outcome
        // and surfaces the appropriate UI.
        cleanup();
        resolve();
      };
      this.listeners.add(onChange);
      try { fire(); } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
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
    let stored: string | undefined;
    try {
      const sessionTok = sessionStorage.getItem(TOKEN_KEY);
      if (sessionTok) {
        stored = sessionTok;
        this.rememberMe = false;
      } else {
        stored = localStorage.getItem(TOKEN_KEY) ?? undefined;
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
      .onDisconnect(() => console.warn("[SpacetimeDB] disconnected"))
      .onConnectError((_ctx: ErrorContext, err: Error) =>
        console.error("[SpacetimeDB] connect error", err));
    if (stored) builder = builder.withToken(stored);
    try {
      this.conn = builder.build();
    } catch (e) {
      console.error("[SpacetimeDB] failed to build connection", e);
    }
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
    try {
      const fromLocal = localStorage.getItem(TOKEN_KEY);
      const fromSession = sessionStorage.getItem(TOKEN_KEY);
      const token = fromLocal ?? fromSession;
      if (!token) return;
      if (b) {
        // Promote to permanent storage.
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.removeItem(TOKEN_KEY);
      } else {
        // Demote to session-only storage; wipe permanent copy so a
        // browser close really clears the identity.
        sessionStorage.setItem(TOKEN_KEY, token);
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch { /* ignore quota / private mode */ }
  }

  /** Write the identity token to whichever storage matches the
   * current rememberMe preference. Pairs with connect() reading
   * from the same place. */
  private persistToken(token: string): void {
    try {
      if (this.rememberMe) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.removeItem(TOKEN_KEY);
      } else {
        sessionStorage.setItem(TOKEN_KEY, token);
        localStorage.removeItem(TOKEN_KEY);
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
    // Find one of my restaurants, or create one. Note: table accessors
    // on `ctx.db` are snake_case (matches the schema name), index
    // accessors are also snake_case (e.g. `.restaurant_id`).
    const myRestaurants = Array.from(ctx.db.restaurant.iter())
      .filter((r) => identityEquals(r.owner, identity));
    if (myRestaurants.length === 0) {
      console.log("[SpacetimeDB] no restaurants — creating one");
      // Listen for our row to arrive before/after the reducer applies.
      // Without this listener, restaurantId stays null for the whole
      // session and cloudSaveNow silently skips every save until the
      // player reloads the page. Idempotent — we capture the first row
      // owned by this identity and unsubscribe.
      const onInsert = (_evCtx: unknown, row: { id: bigint; owner: Identity }): void => {
        if (this.restaurantId != null) return;
        if (!identityEquals(row.owner, identity)) return;
        this.restaurantId = row.id;
        console.log(`[SpacetimeDB] new restaurant ${row.id} ready — cloud saves enabled`);
        try { ctx.db.restaurant.removeOnInsert(onInsert); } catch { /* SDK quirk */ }
      };
      ctx.db.restaurant.onInsert(onInsert);
      conn.reducers.createRestaurant({ name: "My Bistro", public: true });
    } else {
      this.restaurantId = myRestaurants[0].id;
      const snap = ctx.db.save_snapshot.restaurant_id.find(this.restaurantId);
      if (snap) {
        console.log(`[SpacetimeDB] found cloud save for restaurant ${this.restaurantId} on day ${snap.dayNumber} ($${snap.money})`);
        // If the player walked in on a fresh device with no local save,
        // pull the cloud snapshot now and reload. On a device that
        // ALREADY had a local save we leave the cloud copy alone — the
        // local game has already booted and the player can still pull
        // the cloud version manually via SlotsModal's "Load from cloud"
        // button if they want to overwrite.
        this.maybeAutoLoadCloudSave(snap);
      } else {
        console.log(`[SpacetimeDB] restaurant ${this.restaurantId} exists but no save yet`);
      }
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
    // 1) On every local save, schedule a debounced cloud save.
    const originalSaveNow = this.saver.saveNow.bind(this.saver);
    this.saver.saveNow = () => {
      originalSaveNow();
      this.scheduleCloudSave();
    };

    // 2) Achievement unlocks → reducer (idempotent server-side).
    const originalUnlock = this.game.achievements.onUnlock;
    this.game.achievements.onUnlock = (a) => {
      originalUnlock?.(a);
      this.conn?.reducers.unlockAchievement({ achievementId: a.id });
    };

    // 3) End-of-day → submit_leaderboard for each category.
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
    };
  }

  private scheduleCloudSave(): void {
    if (this.saveDebounce != null) window.clearTimeout(this.saveDebounce);
    this.saveDebounce = window.setTimeout(() => this.cloudSaveNow(), 2000);
  }

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
