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
import type { Identity } from "spacetimedb";

const TOKEN_KEY = "cozy-bistro-stdb-token";
const DEFAULT_HOST = "wss://maincloud.spacetimedb.com";
const DEFAULT_MODULE = "cozy-bistro-andre";

export interface SpacetimeConfig {
  /** Module name as published on Maincloud. */
  moduleName?: string;
  /** ws:// or wss:// host. Defaults to Maincloud. */
  host?: string;
}

export class SpacetimeClient {
  private readonly game: Game;
  private readonly saver: SaveSystem;
  private readonly cfg: Required<SpacetimeConfig>;
  private conn: DbConnection | null = null;
  private restaurantId: bigint | null = null;
  private saveDebounce: number | null = null;
  private wired = false;

  constructor(game: Game, saver: SaveSystem, cfg: SpacetimeConfig = {}) {
    this.game = game;
    this.saver = saver;
    this.cfg = {
      moduleName: cfg.moduleName ?? DEFAULT_MODULE,
      host: cfg.host ?? DEFAULT_HOST,
    };
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
      conn.reducers.createRestaurant({ name: "My Bistro", public: true });
      // The subscription will deliver the new row asynchronously.
      // Once it shows up our next save will pick the restaurantId.
    } else {
      this.restaurantId = myRestaurants[0].id;
      const snap = ctx.db.save_snapshot.restaurant_id.find(this.restaurantId);
      if (snap) {
        console.log(`[SpacetimeDB] found cloud save for restaurant ${this.restaurantId} on day ${snap.dayNumber} ($${snap.money})`);
        // Currently we don't override the local save automatically — the
        // game has already started from localStorage. A future "Load from
        // cloud" button can JSON.parse(snap.data) and feed Engine.hydrate.
      } else {
        console.log(`[SpacetimeDB] restaurant ${this.restaurantId} exists but no save yet`);
      }
    }
    this.wireGameHooks();
    this.wired = true;
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
