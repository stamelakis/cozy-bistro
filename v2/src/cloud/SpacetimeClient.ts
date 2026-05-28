/**
 * Thin wrapper around the SpacetimeDB-generated TypeScript bindings.
 *
 * This file deliberately does NOT import from the generated SDK yet —
 * the SDK is created by running:
 *
 *     cd v2/spacetime
 *     spacetime generate --lang typescript --out-dir ../src/cloud/generated --project-path .
 *
 * Once that completes, uncomment the marked sections below and the
 * client will connect on Engine startup, sync the current restaurant's
 * save snapshot, and bridge achievements + leaderboard submissions.
 */

import type { Game } from "../game/Game";
import type { SaveSystem } from "../game/SaveSystem";

// Placeholder type — replaces with the real generated DbConnection once
// `spacetime generate` has been run.
type DbConnection = unknown;

export interface SpacetimeConfig {
  /** Module name as published to Maincloud (e.g. "cozy-bistro-andre"). */
  moduleName: string;
  /** Host. Default is maincloud.spacetimedb.com for the free hosted tier. */
  host?: string;
}

/**
 * Manages the connection to the SpacetimeDB module + bridges Game
 * events to reducer calls.
 */
export class SpacetimeClient {
  private readonly game: Game;
  private readonly saver: SaveSystem;
  private readonly cfg: SpacetimeConfig;
  private conn: DbConnection | null = null;
  /** id of the restaurant row being saved into. Set on first connect. */
  private restaurantId: bigint | null = null;
  /** debounce timer so rapid local saves don't spam the network. */
  private saveDebounce: number | null = null;

  constructor(game: Game, saver: SaveSystem, cfg: SpacetimeConfig) {
    this.game = game;
    this.saver = saver;
    this.cfg = cfg;
  }

  /** Begin the connection. Safe to call before bindings exist — will
   * just log a hint and no-op. */
  async connect(): Promise<void> {
    /* === Uncomment after `spacetime generate` ===

    const { DbConnection } = await import("./generated");
    const host = this.cfg.host ?? "wss://maincloud.spacetimedb.com";

    this.conn = DbConnection.builder()
      .withUri(host)
      .withModuleName(this.cfg.moduleName)
      // Persist the token in localStorage so the same identity carries
      // across reloads — gives us a stable player row.
      .withToken(localStorage.getItem("cozy-bistro-stdb-token") ?? undefined)
      .onConnect((conn, identity, token) => {
        localStorage.setItem("cozy-bistro-stdb-token", token);
        console.log("[SpacetimeDB] connected as", identity.toHexString());
        this.afterConnect(conn);
      })
      .onDisconnect(() => console.warn("[SpacetimeDB] disconnected"))
      .onConnectError((_, err) => console.error("[SpacetimeDB] connect error", err))
      .build();

    === */
    console.info(
      "[SpacetimeDB] Bindings not generated yet. Run `spacetime generate --lang typescript --out-dir src/cloud/generated --project-path v2/spacetime` and then uncomment the connect() body."
    );
  }

  /** Hook up Game events → reducer calls. Called once after a successful
   * connection. */
  private afterConnect(_conn: DbConnection): void {
    /* === Uncomment after `spacetime generate` ===

    // 1) Make sure we have at least one restaurant; first-time players
    //    get one auto-created.
    const myRestaurants = Array.from(_conn.db.restaurant.iter())
      .filter((r) => r.owner.isEqual(_conn.identity!));
    if (myRestaurants.length === 0) {
      _conn.reducers.createRestaurant("My Bistro", true);
    } else {
      this.restaurantId = myRestaurants[0].id;
      // Load the snapshot if we have one.
      const snap = _conn.db.saveSnapshot.restaurantId.find(this.restaurantId);
      if (snap) {
        try {
          const state = JSON.parse(snap.data);
          // TODO: feed `state` into Engine's hydration path.
          console.log("[SpacetimeDB] cloud save loaded:", state);
        } catch (e) {
          console.warn("[SpacetimeDB] cloud save was corrupt:", e);
        }
      }
    }

    // 2) Wire SaveSystem.saveNow → reducer (debounced).
    const originalSaveNow = this.saver.saveNow.bind(this.saver);
    this.saver.saveNow = () => {
      originalSaveNow();
      this.scheduleCloudSave();
    };

    // 3) Wire achievements.
    const original = this.game.achievements.onUnlock;
    this.game.achievements.onUnlock = (a) => {
      original?.(a);
      _conn.reducers.unlockAchievement(a.id);
    };

    // 4) Wire day-end leaderboard submissions.
    const originalDayEnd = this.game.onDayEnded;
    this.game.onDayEnded = (s) => {
      originalDayEnd?.(s);
      if (this.restaurantId == null) return;
      _conn.reducers.submitLeaderboard(this.restaurantId, "daily_revenue", BigInt(s.revenue), s.dayNumber);
      _conn.reducers.submitLeaderboard(this.restaurantId, "daily_served", BigInt(s.served), s.dayNumber);
    };

    === */
  }

  /** Debounced upload of the latest save state to the DB. */
  scheduleCloudSave(): void {
    if (this.saveDebounce != null) window.clearTimeout(this.saveDebounce);
    this.saveDebounce = window.setTimeout(() => this.cloudSaveNow(), 2000);
  }

  cloudSaveNow(): void {
    /* === Uncomment after `spacetime generate` ===

    if (!this.conn || this.restaurantId == null) return;
    const json = JSON.stringify(this.saver.lastSnapshotForCloud());
    (this.conn as any).reducers.saveSnapshot(
      this.restaurantId,
      json,
      this.game.day.getDayNumber(),
      BigInt(Math.round(this.game.economy.getMoney())),
      this.game.reputation.getAverageRating(),
      this.game.getLuxuryTier(),
    );

    === */
    // Touch the bound state so TS doesn't flag unused-field on the stub.
    void this.game; void this.saver; void this.cfg;
    void this.conn; void this.restaurantId; void this.afterConnect;
  }
}
