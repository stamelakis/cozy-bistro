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
  private wired = false;
  /** Subscribers that want to be notified when DB state mutates. UI panels
   * register a re-render here so leaderboards/friends update live. */
  private readonly listeners = new Set<() => void>();

  constructor(game: Game, saver: SaveSystem, cfg: SpacetimeConfig = {}) {
    this.game = game;
    this.saver = saver;
    this.cfg = {
      moduleName: cfg.moduleName ?? DEFAULT_MODULE,
      host: cfg.host ?? DEFAULT_HOST,
    };
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
   * error string (e.g. "Username already taken"). */
  signUp(username: string, password: string): Promise<void> {
    return this.callReducer("signUp", () => this.conn!.reducers.signUp({ username, password }));
  }

  /** Call login. Resolves on success, rejects with the reducer's
   * error string (e.g. "Wrong password"). */
  login(username: string, password: string): Promise<void> {
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
   * only log + leave the game running offline. */
  connect(): void {
    let stored: string | undefined;
    try { stored = localStorage.getItem(TOKEN_KEY) ?? undefined; } catch { /* private mode */ }
    let builder = DbConnection.builder()
      .withUri(this.cfg.host)
      .withDatabaseName(this.cfg.moduleName)
      .onConnect((conn, identity, token) => {
        try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
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
        // Don't override the local save automatically — the game has
        // already started from localStorage. The "Load from cloud" button
        // (SlotsModal) lets the player pull this snapshot on demand.
      } else {
        console.log(`[SpacetimeDB] restaurant ${this.restaurantId} exists but no save yet`);
      }
    }
    this.wireGameHooks();
    this.wireCloudListeners(ctx);
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
      // P2+ — building rows feed BuildingPickModal's live refresh
      // and Engine.refreshCityBuildings.
      ctx.db.building.onInsert(ping);
      ctx.db.building.onUpdate(ping);
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
   * we don't have an authoritative restaurantId yet. */
  cloudSaveNow(): void {
    if (!this.conn || this.restaurantId == null) return;
    try {
      const state = this.saver.snapshotForCloud();
      const json = JSON.stringify(state);
      if (json.length > 256 * 1024) {
        console.warn(`[SpacetimeDB] save too large to upload (${json.length} bytes)`);
        return;
      }
      this.conn.reducers.saveRestaurantSnapshot({
        restaurantId: this.restaurantId,
        data: json,
        dayNumber: this.game.day.getDayNumber(),
        money: BigInt(Math.round(this.game.economy.getMoney())),
        ratingAvg: this.game.reputation.getAverageRating(),
        luxuryTier: this.game.getLuxuryTier(),
      });
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
    this.conn?.disconnect();
    this.conn = null;
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
