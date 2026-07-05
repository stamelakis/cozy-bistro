//! Server-side nav-grid + A* pathfinder — PASS 1 (additive, unwired).
//!
//! A faithful Rust port of the client's `src/game/Pathfinding.ts`
//! (the A*/nav-grid source of truth) plus the rotated-footprint math
//! from `src/game/FurnitureRegistry.ts` (`axisAlignedSinCos`,
//! `footprintCoversCell`). Nothing in this module is called yet — it
//! only needs to exist and compile. A later pass (Pass 3) wires it into
//! the staff actor tick. Zero risk to live behaviour.
//!
//! ## Determinism
//!
//! SpacetimeDB reducers must be deterministic: identical inputs must
//! produce identical outputs across replicas. So unlike the client we
//! avoid any non-deterministic iteration:
//!   - the A* open list is a `Vec` with a stable linear-scan-for-min
//!     (ties resolved by lowest index — the first node pushed wins),
//!     mirroring the client's `bestIdx` scan exactly;
//!   - blocked cells / edges are returned in `BTreeSet`s so any caller
//!     that iterates them does so in a sorted, reproducible order;
//!   - `g_score` / `came_from` use `BTreeMap` keyed by the same
//!     `"x,z"` string keys the client uses, so reconstruction is
//!     identical.
//! There is no `Date.now()` / RNG anywhere in the original algorithm,
//! so the port has no hidden non-determinism to launder.
//!
//! ## Parity contract with Pathfinding.ts
//!
//! Constants match EXACTLY: GRID_MIN/MAX = -4/5, MAX_ITERATIONS = 500,
//! the stair tiles, the 4-connected neighbour order, the Manhattan
//! heuristic, the goal-cell-always-traversable rule, the edge-wall
//! rejection, the Bresenham direct-line shortcut (disabled whenever any
//! edge wall is present), and `reconstruct` replacing the last waypoint
//! with the exact destination. `find_path` never returns empty — the
//! fallback is the single destination waypoint, matching the client's
//! `[finalTarget]`.
//!
//! ## Where the server differs from the client (documented divergences)
//!
//!  1. Category source. The client reads `def.category` + `def.placement`
//!     from the TS catalog. The server has no catalog; it reads the
//!     category from the `furniture_meta` table (seeded by the client's
//!     admin push). `furniture_meta` does NOT carry `placement`, so the
//!     placement-based exclusion in the client's `isBlockingCategory`
//!     (`placement === "wall-shelf" | "wall" | "ceiling" | "surface"`
//!     → never blocks) can only be partially reproduced: it falls out
//!     naturally for wall/edge/ceiling pieces whose CATEGORY is
//!     non-blocking (wall/door/decoration/lamp), but a piece whose
//!     category IS blocking yet sits on a wall shelf (only
//!     `kitchen-upper-d`, category `storage`, placement `wall-shelf`)
//!     would over-block its footprint cells server-side. This is the
//!     documented, degrade-safe limitation of a category-only meta
//!     table. (`bar-counter` / `bar-end` use category `bar`, which is
//!     NOT in the blocking set, so bars don't block on EITHER side —
//!     same as the client.)
//!  2. Unseeded defs. If a placed def has no `furniture_meta` row, the
//!     server treats it as non-blocking (degrade-safe) rather than
//!     guessing — the client always has the catalog so never hits this.
//!  3. `def_size` is a hand-written table of the multi-tile catalog
//!     defs (everything else defaults to 1×1). The client reads
//!     `def.size` directly. The list is derived from
//!     `src/data/furnitureCatalog.ts` (every def whose size != 1×1).
//!     The optional L-shape `def.footprint` mask (only 2 corner-sofa
//!     defs) is intentionally NOT ported — those cells just read as a
//!     solid 2×2 rectangle server-side, which only ever over-blocks the
//!     open elbow (safe).
//!
//! Float rounding: the client uses JS `Math.round`, which rounds halves
//! toward +∞ (`Math.round(-0.5) === -0`, `Math.round(2.5) === 3`).
//! Rust's `f32::round` rounds halves AWAY from zero
//! (`(-0.5f32).round() == -1.0`). To stay bit-identical with the grid
//! the client produces, all footprint/axis rounding goes through
//! `js_round` (= `(x + 0.5).floor()`), which reproduces JS semantics.

#![allow(dead_code)] // Pass 1: nothing calls these yet; Pass 3 wires them.

use std::collections::{BTreeMap, BTreeSet};

use spacetimedb::ReducerContext;

use crate::tables::{furniture_meta, placed_furniture};

// === Constants (match Pathfinding.ts EXACTLY) ============================

/// Grid bounds inside the restaurant — cells (x, z) with both axes in
/// [-4, 5]. The building's exterior walls sit at half-integer
/// coordinates, so the playable tiles are exactly these 100.
const GRID_MIN: i32 = -4;
const GRID_MAX: i32 = 5;

/// Search cap so a degenerate query doesn't hang the tick. 500 nodes is
/// plenty for a 10×10 grid.
const MAX_ITERATIONS: u32 = 500;

/// Distance below which an actor is considered "at" a waypoint.
/// Exposed for parity / future wiring; not used by the algorithm here.
pub(crate) const PATH_ARRIVAL_THRESHOLD: f32 = 0.2;

/// LOWER-floor stair landing tile (cell directly south of the bottom step).
/// pub(crate) so the movement tick (next_step_multi) can route to the stairs.
pub(crate) const STAIR_BOTTOM_TILE: (i32, i32) = (-4, -1);
/// UPPER-floor stair landing tile (cell directly east of the top step).
pub(crate) const STAIR_TOP_TILE: (i32, i32) = (-3, -4);

/// 4-connected neighbours, in the SAME order as the client's NEIGHBOURS
/// array. Order matters for determinism of which equal-cost path wins.
const NEIGHBOURS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

// === JS-compatible rounding ==============================================

/// Reproduce JavaScript `Math.round`: round half toward +∞.
/// `Math.round(x) === Math.floor(x + 0.5)`. Rust's `f32::round` rounds
/// half away from zero, which differs for negative .5 values, so we must
/// use this for any value the client also rounds via `Math.round`.
#[inline]
fn js_round(x: f32) -> i32 {
    (x + 0.5).floor() as i32
}

// === Footprint geometry (port of FurnitureRegistry.ts) ===================

/// Bucket a rotation into {-1,0,1} sin/cos, mirroring
/// `axisAlignedSinCos`. Players rotate in π/2 steps so this is lossless
/// in practice.
fn axis_aligned_sin_cos(rot_y: f32) -> (i32, i32) {
    let sin = js_round(rot_y.sin());
    let cos = js_round(rot_y.cos());
    let clamp = |v: i32| if v == 0 { 0 } else if v > 0 { 1 } else { -1 };
    (clamp(sin), clamp(cos))
}

/// True if the integer cell (cell_x, cell_z) lies inside this item's
/// rotated footprint. Verbatim port of `footprintCoversCell` for the
/// solid-rectangle case (the optional L-shape mask is not ported — see
/// module docs). `width`/`depth` are the def's unrotated size.
fn footprint_covers_cell(
    item_x: f32,
    item_z: f32,
    rot_y: f32,
    width: i32,
    depth: i32,
    cell_x: i32,
    cell_z: i32,
) -> bool {
    let (sin, _cos) = axis_aligned_sin_cos(rot_y);
    let swapped = sin != 0;
    let w = width as f32;
    let d = depth as f32;
    let eff_w = if swapped { d } else { w };
    let eff_d = if swapped { w } else { d };
    // Integer-cell extents covered by the rotated footprint rectangle.
    let min_x = js_round(item_x - eff_w / 2.0 + 0.5);
    let max_x = js_round(item_x + eff_w / 2.0 - 0.5);
    let min_z = js_round(item_z - eff_d / 2.0 + 0.5);
    let max_z = js_round(item_z + eff_d / 2.0 - 0.5);
    if cell_x < min_x || cell_x > max_x {
        return false;
    }
    if cell_z < min_z || cell_z > max_z {
        return false;
    }
    // No L-shape mask ported → solid rectangle, always covered here.
    true
}

/// Every integer cell this item's footprint covers (solid rectangle).
/// Mirror of `footprintCells` minus the mask. Used to mark blocked cells.
fn footprint_cells(item_x: f32, item_z: f32, rot_y: f32, width: i32, depth: i32) -> Vec<(i32, i32)> {
    let (sin, _cos) = axis_aligned_sin_cos(rot_y);
    let swapped = sin != 0;
    let w = width as f32;
    let d = depth as f32;
    let eff_w = if swapped { d } else { w };
    let eff_d = if swapped { w } else { d };
    let min_x = js_round(item_x - eff_w / 2.0 + 0.5);
    let max_x = js_round(item_x + eff_w / 2.0 - 0.5);
    let min_z = js_round(item_z - eff_d / 2.0 + 0.5);
    let max_z = js_round(item_z + eff_d / 2.0 - 0.5);
    let mut out = Vec::new();
    let mut cx = min_x;
    while cx <= max_x {
        let mut cz = min_z;
        while cz <= max_z {
            if footprint_covers_cell(item_x, item_z, rot_y, width, depth, cx, cz) {
                out.push((cx, cz));
            }
            cz += 1;
        }
        cx += 1;
    }
    out
}

// === Catalog-derived tables ==============================================

/// Footprint (width, depth) for a def. Hand-written from
/// `src/data/furnitureCatalog.ts` — every catalog def whose `size` is
/// NOT 1×1 is listed here; everything else defaults to (1, 1).
///
/// Source list (id :: w×d :: catalog category):
///   small-table, round-table, dining-table, fancy-table, cloth-table,
///   glass-table                    :: 2×2 :: table
///   sofa-corner, sofa-design-c     :: 2×2 :: chair
///   fridge-large                   :: 2×2 :: storage
///   fountain                       :: 2×2 :: decoration
///   bench-cushion, bench-cushion-low, bench-plain, sofa, sofa-long,
///   sofa-design                    :: 2×1 :: chair
///   fridge-double                  :: 2×1 :: storage
///   kitchen-upper-d                :: 2×1 :: storage  (placement wall-shelf)
///   bar-counter                    :: 2×1 :: bar
///   bookcase, bookcase-open, aquarium, fireplace :: 2×1 :: decoration
///   planter-box                    :: 2×1 :: plant
///   pizza-oven                     :: 2×1 :: stove
///   bathtub                        :: 2×1 :: bathroom
///   wall-doorway-w                 :: 2×1 :: door (placement edge)
fn def_size(def_id: &str) -> (i32, i32) {
    match def_id {
        // --- 2×2 ---
        "small-table" | "round-table" | "dining-table" | "fancy-table" | "cloth-table"
        | "glass-table" => (2, 2),
        "sofa-corner" | "sofa-design-c" => (2, 2),
        "fridge-large" => (2, 2),
        "fountain" => (2, 2),
        // --- 2×1 ---
        "bench-cushion" | "bench-cushion-low" | "bench-plain" | "sofa" | "sofa-long"
        | "sofa-design" => (2, 1),
        "fridge-double" => (2, 1),
        "kitchen-upper-d" => (2, 1),
        "bar-counter" => (2, 1),
        "bookcase" | "bookcase-open" | "aquarium" | "fireplace" => (2, 1),
        "planter-box" => (2, 1),
        "pizza-oven" => (2, 1),
        "bathtub" => (2, 1),
        "wall-doorway-w" => (2, 1),
        // --- everything else ---
        _ => (1, 1),
    }
}

/// True for edge-placed pieces that block the grid EDGE they sit on.
/// Mirrors `isBlockingEdgeWall`: walls, half-walls and windows block;
/// the internal doorway (`int-doorway`) stays passable.
fn def_is_blocking_edge_wall(def_id: &str) -> bool {
    def_id == "int-wall" || def_id == "int-wall-half" || def_id == "int-window"
}

/// Decide whether a furniture CATEGORY should block walking on its cells.
/// Mirrors `Pathfinding.isBlockingCategory`'s category switch (the server
/// has no `placement`, so the placement-based early-out is handled by the
/// `furniture_meta` category not being in this set — see module docs).
fn is_blocking_category(category: &str) -> bool {
    matches!(
        category,
        "table" | "chair" | "stove" | "wash" | "appliance" | "counter" | "storage"
            | "bathroom" | "plant"
    )
}

// === Edge keys (port of edgeKey / edgeKeyFromWall) =======================

/// Key for the edge between two 4-neighbour cells. Tags horizontal vs
/// vertical so the encoding is unique regardless of cell order and lines
/// up 1:1 with `edge_key_from_wall`. Half-integer midpoints are printed
/// the same way JS prints them (e.g. `2.5`, `-3.5`) — matching the
/// client's template-string keys so the two key spaces are identical.
fn edge_key(ax: i32, az: i32, bx: i32, bz: i32) -> String {
    if ax != bx {
        // East/west step → vertical wall at midpoint x, same z.
        let mid_x = (ax + bx) as f32 / 2.0;
        format!("v:{},{}", fmt_coord(mid_x), az)
    } else {
        // North/south step → horizontal wall at midpoint z, same x.
        let mid_z = (az + bz) as f32 / 2.0;
        format!("h:{},{}", ax, fmt_coord(mid_z))
    }
}

/// Key for the edge a wall sits on. Walls land at rot_y=0 (runs along X →
/// half-integer z) or rot_y=π/2 (runs along Z → half-integer x). Reads
/// sin rather than `==` so it tolerates an extra full turn from a move.
/// `wx`/`wz` are the wall's exact (possibly half-integer) coordinates.
fn edge_key_from_wall(wx: f32, wz: f32, rot_y: f32) -> String {
    let is_vertical = rot_y.sin().abs() > 0.5;
    if is_vertical {
        format!("v:{},{}", fmt_coord(wx), fmt_coord(wz))
    } else {
        format!("h:{},{}", fmt_coord(wx), fmt_coord(wz))
    }
}

/// Format a coordinate the way JS stringifies a number into a template
/// literal: integers print without a decimal point (`3`, `-4`), and the
/// only non-integers we ever produce are exact halves (`2.5`, `-3.5`).
/// This keeps the Rust edge-key string space identical to the client's.
fn fmt_coord(v: f32) -> String {
    if v == v.trunc() {
        // Whole number — print as an integer, no ".0".
        format!("{}", v as i64)
    } else {
        // Exact half. `{}` on f32 prints "2.5" / "-3.5" with no trailing
        // zeros, matching JS number stringification for halves.
        format!("{}", v)
    }
}

#[inline]
fn cell_key(x: i32, z: i32) -> String {
    format!("{},{}", x, z)
}

#[inline]
fn heuristic(x1: i32, z1: i32, x2: i32, z2: i32) -> i32 {
    (x1 - x2).abs() + (z1 - z2).abs()
}

// === Blocked-set construction ============================================

/// Walk the restaurant's placed furniture on `floor` and collect every
/// blocked cell + every blocked edge, exactly as `computeBlocked` does.
///
/// Sourcing the category: for each placed row we look up its category via
/// `furniture_meta().def_id().find(def_id)`. If `is_blocking_category`,
/// every footprint cell (via `def_size` + the rotated-rectangle math) is
/// added. A def with NO furniture_meta row is treated as non-blocking
/// (degrade-safe). Edge walls add their blocked edge regardless of meta
/// (the edge-wall set is identity-based, like the client).
///
/// Returns sorted sets so any downstream iteration is deterministic.
pub(crate) fn compute_blocked(
    ctx: &ReducerContext,
    rid: u64,
    floor: u32,
) -> (BTreeSet<(i32, i32)>, BTreeSet<String>) {
    let mut cells: BTreeSet<(i32, i32)> = BTreeSet::new();
    let mut edges: BTreeSet<String> = BTreeSet::new();

    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        // Only same-floor items block this floor.
        if f.floor != floor {
            continue;
        }
        // Edge-placed partition walls/windows block the grid line they
        // sit on. Doorways stay passable (def_is_blocking_edge_wall is
        // false for int-doorway). This is identity-based and does not
        // consult furniture_meta — matching the client, which keys off
        // the def id, not the category.
        if def_is_blocking_edge_wall(&f.def_id) {
            edges.insert(edge_key_from_wall(f.x, f.z, f.rot_y));
            continue;
        }
        // Otherwise: a solid floor item blocks its footprint iff its
        // category (from furniture_meta) is a blocking category. No meta
        // row → treat as non-blocking.
        let category = match ctx.db.furniture_meta().def_id().find(f.def_id.clone()) {
            Some(m) => m.category,
            None => continue, // unseeded def → degrade-safe non-blocking
        };
        if !is_blocking_category(&category) {
            continue;
        }
        let (w, d) = def_size(&f.def_id);
        for (cx, cz) in footprint_cells(f.x, f.z, f.rot_y, w, d) {
            cells.insert((cx, cz));
        }
    }

    // Phase M.17 — block the procedural STAIRCASE column on every floor (the
    // upper slabs have a hole punched here, so those cells are over the void
    // anyway). Same-floor pathing then routes AROUND the stairwell instead of
    // clipping through it. The landing tiles STAIR_BOTTOM_TILE (-4,-1) and
    // STAIR_TOP_TILE (-3,-4) stay clear — find_multi_floor_path routes the
    // cross-floor legs to them. Mirrors the client's computeBlocked.
    cells.insert((-4, -2));
    cells.insert((-4, -3));
    cells.insert((-4, -4));

    (cells, edges)
}

// === Per-reducer-call memo of compute_blocked ============================
//
// compute_blocked rescans placed_furniture (+ a furniture_meta lookup per
// row) on every call. With guests + staff each running find_path per
// tick, that scan repeated 30+× per restaurant_tick for the SAME
// (rid,floor). Memoise it for the duration of one reducer call, keyed by
// ctx.timestamp (constant within a call, distinct across ticks) so a
// furniture edit on the next tick is always picked up. WASM is single-
// threaded, so the thread_local is effectively a per-call global; the
// memo returns exactly what compute_blocked would, so determinism (and
// cross-replica agreement) is unaffected.
struct BlockedMemo {
    stamp: i64,
    map: std::collections::HashMap<(u64, u32), (BTreeSet<(i32, i32)>, BTreeSet<String>)>,
}
thread_local! {
    static BLOCKED_MEMO: std::cell::RefCell<BlockedMemo> = std::cell::RefCell::new(
        BlockedMemo { stamp: i64::MIN, map: std::collections::HashMap::new() }
    );
}

/// compute_blocked, memoised per reducer call (see BlockedMemo).
fn compute_blocked_cached(
    ctx: &ReducerContext,
    rid: u64,
    floor: u32,
) -> (BTreeSet<(i32, i32)>, BTreeSet<String>) {
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    BLOCKED_MEMO.with(|c| {
        let mut c = c.borrow_mut();
        if c.stamp != now {
            c.map.clear();
            c.stamp = now;
        }
        if let Some(v) = c.map.get(&(rid, floor)) {
            return v.clone();
        }
        let v = compute_blocked(ctx, rid, floor);
        c.map.insert((rid, floor), v.clone());
        v
    })
}

/// True if every cell on the straight line between (x1,z1) and (x2,z2),
/// exclusive of both endpoints, is unblocked. Bresenham traversal,
/// verbatim port of `directLineClear`. The goal cell is intentionally
/// skipped (caller may route TO a blocked goal).
fn direct_line_clear(
    x1: i32,
    z1: i32,
    x2: i32,
    z2: i32,
    blocked: &BTreeSet<(i32, i32)>,
) -> bool {
    let dx = (x2 - x1).abs();
    let dz = (z2 - z1).abs();
    let sx = if x1 < x2 { 1 } else { -1 };
    let sz = if z1 < z2 { 1 } else { -1 };
    let mut err = dx - dz;
    let mut cx = x1;
    let mut cz = z1;
    while cx != x2 || cz != z2 {
        let e2 = err * 2;
        if e2 > -dz {
            err -= dz;
            cx += sx;
        }
        if e2 < dx {
            err += dx;
            cz += sz;
        }
        // Skip the goal cell — caller wants to reach there even if blocked.
        if cx == x2 && cz == z2 {
            break;
        }
        if blocked.contains(&(cx, cz)) {
            return false;
        }
    }
    true
}

// === A* path (port of findPath) ==========================================

/// Find a tile-aligned path from (from_x, from_z) to (to_x, to_z) on
/// `floor`. The returned waypoints ALWAYS end EXACTLY at (to_x, to_z) —
/// the last A* waypoint is replaced by the precise destination. Returns a
/// single direct step when unobstructed, a multi-step route otherwise,
/// and `[(to_x, to_z)]` as a safe fallback when no path is found (never
/// empty) — matching the client's `[finalTarget]`.
pub(crate) fn find_path(
    ctx: &ReducerContext,
    rid: u64,
    from_x: f32,
    from_z: f32,
    to_x: f32,
    to_z: f32,
    floor: u32,
) -> Vec<(f32, f32)> {
    let start_x = js_round(from_x);
    let start_z = js_round(from_z);
    let goal_x = js_round(to_x);
    let goal_z = js_round(to_z);
    let final_target = (to_x, to_z);

    if start_x == goal_x && start_z == goal_z {
        return vec![final_target];
    }

    let (blocked, blocked_edges) = compute_blocked_cached(ctx, rid, floor);

    // Direct-line shortcut — only when no edge walls are in play (a
    // Bresenham step can cross a wall edge diagonally, which we can't
    // safely interrogate here, so we fall through to A* in that case).
    if blocked_edges.is_empty() && direct_line_clear(start_x, start_z, goal_x, goal_z, &blocked) {
        return vec![final_target];
    }

    // Open list as a Vec; lowest-f via stable linear scan (lowest index
    // wins ties) → deterministic, mirrors the client's bestIdx loop.
    struct Node {
        x: i32,
        z: i32,
        f: i32,
    }
    let mut open: Vec<Node> = Vec::new();
    let mut g_score: BTreeMap<String, i32> = BTreeMap::new();
    let mut came: BTreeMap<String, String> = BTreeMap::new();

    let start_key = cell_key(start_x, start_z);
    let goal_key = cell_key(goal_x, goal_z);
    g_score.insert(start_key.clone(), 0);
    open.push(Node {
        x: start_x,
        z: start_z,
        f: heuristic(start_x, start_z, goal_x, goal_z),
    });

    let mut iter: u32 = 0;
    while !open.is_empty() && iter < MAX_ITERATIONS {
        iter += 1;
        // Pop lowest-f node (linear scan; first/lowest index wins ties).
        let mut best_idx = 0usize;
        for i in 1..open.len() {
            if open[i].f < open[best_idx].f {
                best_idx = i;
            }
        }
        let current = open.swap_remove_stable(best_idx);
        let curr_key = cell_key(current.x, current.z);

        if curr_key == goal_key {
            return reconstruct(&came, &start_key, &goal_key, final_target);
        }

        for (dx, dz) in NEIGHBOURS.iter() {
            let nx = current.x + dx;
            let nz = current.z + dz;
            if nx < GRID_MIN || nx > GRID_MAX || nz < GRID_MIN || nz > GRID_MAX {
                continue;
            }
            let n_key = cell_key(nx, nz);
            let is_goal = n_key == goal_key;
            // Goal cell is always traversable so callers can route TO a
            // chair/stove/counter/etc.
            if !is_goal && blocked.contains(&(nx, nz)) {
                continue;
            }
            // Partition wall on the EDGE between the two cells rejects the
            // step (even toward the goal — no ending on the far side of a
            // wall unless there's a doorway).
            if blocked_edges.contains(&edge_key(current.x, current.z, nx, nz)) {
                continue;
            }
            let tentative_g = g_score.get(&curr_key).copied().unwrap_or(i32::MAX);
            // Guard against the i32::MAX sentinel overflowing on +1.
            let tentative_g = if tentative_g == i32::MAX {
                i32::MAX
            } else {
                tentative_g + 1
            };
            let existing_g = g_score.get(&n_key).copied().unwrap_or(i32::MAX);
            if tentative_g < existing_g {
                g_score.insert(n_key.clone(), tentative_g);
                came.insert(n_key.clone(), curr_key.clone());
                open.push(Node {
                    x: nx,
                    z: nz,
                    f: tentative_g.saturating_add(heuristic(nx, nz, goal_x, goal_z)),
                });
            }
        }
    }

    // Fallback: head straight at the goal so the actor doesn't freeze.
    vec![final_target]
}

/// Reconstruct the path from the came-from chain, then replace the final
/// waypoint with the exact requested destination. Mirror of `reconstruct`.
fn reconstruct(
    came: &BTreeMap<String, String>,
    start_key: &str,
    goal_key: &str,
    final_target: (f32, f32),
) -> Vec<(f32, f32)> {
    let mut path: Vec<(f32, f32)> = Vec::new();
    let mut k = goal_key.to_string();
    while k != start_key {
        // Parse "x,z" back into integer cell coords.
        let (x, z) = parse_cell_key(&k);
        path.insert(0, (x as f32, z as f32));
        match came.get(&k) {
            Some(prev) => k = prev.clone(),
            None => break,
        }
    }
    // Land precisely at the requested destination, not the cell centre.
    if let Some(last) = path.last_mut() {
        *last = final_target;
    }
    path
}

/// Parse a `"x,z"` cell key back into integer coordinates. Keys are only
/// ever produced by `cell_key`, so this is total in practice.
fn parse_cell_key(k: &str) -> (i32, i32) {
    let mut parts = k.split(',');
    let x = parts.next().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
    let z = parts.next().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
    (x, z)
}

// === Multi-floor path (port of findMultiFloorPath) =======================

/// A single multi-floor waypoint. `from_stair` is true on the first step
/// of a new floor (i.e. the actor just stepped off the stairs) so the
/// mover can drive the Y interpolation across the stair geometry.
pub(crate) struct PathStep {
    pub x: f32,
    pub z: f32,
    pub floor: u32,
    pub from_stair: bool,
}

/// Plan a path from one floor to another (possibly equal), chaining one
/// stair per floor difference. Same-floor falls through to a single
/// `find_path`. Verbatim port of `findMultiFloorPath` (the floor values
/// are already concrete `u32`s on the server, so the client's
/// `Number.isFinite` coercion is unnecessary).
pub(crate) fn find_multi_floor_path(
    ctx: &ReducerContext,
    rid: u64,
    from: (f32, f32, u32),
    to: (f32, f32, u32),
) -> Vec<PathStep> {
    let (from_x, from_z, from_floor) = from;
    let (to_x, to_z, to_floor) = to;

    if from_floor == to_floor {
        return find_path(ctx, rid, from_x, from_z, to_x, to_z, from_floor)
            .into_iter()
            .map(|(x, z)| PathStep {
                x,
                z,
                floor: from_floor,
                from_stair: false,
            })
            .collect();
    }

    let mut result: Vec<PathStep> = Vec::new();
    let ascending = to_floor > from_floor;
    let mut cur_x = from_x;
    let mut cur_z = from_z;
    let mut cur_floor = from_floor;

    // Walk one storey at a time so a 0 → 2 trip lands cleanly on each
    // intermediate slab before climbing the next flight.
    while cur_floor != to_floor {
        let next_floor = if ascending {
            cur_floor + 1
        } else {
            cur_floor - 1
        };
        // Stair entry/exit depend on direction.
        let entry = if ascending { STAIR_BOTTOM_TILE } else { STAIR_TOP_TILE };
        let exit = if ascending { STAIR_TOP_TILE } else { STAIR_BOTTOM_TILE };
        // Walk to the stair entry on this floor.
        let walk = find_path(
            ctx,
            rid,
            cur_x,
            cur_z,
            entry.0 as f32,
            entry.1 as f32,
            cur_floor,
        );
        for (x, z) in walk {
            result.push(PathStep {
                x,
                z,
                floor: cur_floor,
                from_stair: false,
            });
        }
        // Stair traversal — land on the next floor at the opposite end.
        result.push(PathStep {
            x: exit.0 as f32,
            z: exit.1 as f32,
            floor: next_floor,
            from_stair: true,
        });
        cur_x = exit.0 as f32;
        cur_z = exit.1 as f32;
        cur_floor = next_floor;
    }

    // Final leg on the destination floor.
    let final_walk = find_path(ctx, rid, cur_x, cur_z, to_x, to_z, to_floor);
    for (x, z) in final_walk {
        result.push(PathStep {
            x,
            z,
            floor: to_floor,
            from_stair: false,
        });
    }
    result
}

// === Snap-to-clear (port of snapToClear) =================================

/// Snap (x,z) to the nearest clear tile centre on `floor`, searching
/// outward in rings up to radius 4. Returns the input unchanged when it's
/// already clear (with the same body-radius push-out the client applies
/// to a jittered spot grazing a blocked 4-neighbour). Verbatim port of
/// `snapToClear` with the default `maxRadius = 4`.
pub(crate) fn snap_to_clear(
    ctx: &ReducerContext,
    rid: u64,
    x: f32,
    z: f32,
    floor: u32,
) -> (f32, f32) {
    const MAX_RADIUS: i32 = 4;
    let (cells, _edges) = compute_blocked(ctx, rid, floor);
    let blocked = |cx: i32, cz: i32| cells.contains(&(cx, cz));

    let rx = js_round(x);
    let rz = js_round(z);

    if !blocked(rx, rz) {
        // On a clear tile, but the body has radius: if a jittered offset
        // reaches a blocked 4-neighbour, snap to the tile centre for full
        // clearance; otherwise keep the jittered spot.
        const R: f32 = 0.15;
        let rxf = rx as f32;
        let rzf = rz as f32;
        let clips = (x - rxf > R && blocked(rx + 1, rz))
            || (x - rxf < -R && blocked(rx - 1, rz))
            || (z - rzf > R && blocked(rx, rz + 1))
            || (z - rzf < -R && blocked(rx, rz - 1));
        return if clips { (rxf, rzf) } else { (x, z) };
    }

    for r in 1..=MAX_RADIUS {
        let mut best: Option<(i32, i32)> = None;
        let mut best_d = f32::INFINITY;
        for dx in -r..=r {
            for dz in -r..=r {
                // Current ring only (Chebyshev distance == r).
                if dx.abs().max(dz.abs()) != r {
                    continue;
                }
                let cx = rx + dx;
                let cz = rz + dz;
                if blocked(cx, cz) {
                    continue;
                }
                let cxf = cx as f32;
                let czf = cz as f32;
                let d = (cxf - x) * (cxf - x) + (czf - z) * (czf - z);
                if d < best_d {
                    best_d = d;
                    best = Some((cx, cz));
                }
            }
        }
        if let Some((bx, bz)) = best {
            return (bx as f32, bz as f32);
        }
    }

    (x, z)
}

// === Small helpers =======================================================

/// `Vec::swap_remove` reorders the tail, which would make the open-list
/// scan order depend on prior removals — a subtle determinism hazard and
/// a behavioural divergence from the client's `splice` (which preserves
/// order). This stable variant removes `idx` while keeping the relative
/// order of the remaining elements, exactly like `Array.prototype.splice`.
trait StableRemove<T> {
    fn swap_remove_stable(&mut self, idx: usize) -> T;
}
impl<T> StableRemove<T> for Vec<T> {
    fn swap_remove_stable(&mut self, idx: usize) -> T {
        self.remove(idx)
    }
}
