import type { SpacetimeClient } from "../cloud/SpacetimeClient";

/**
 * Full-screen modal shown to a freshly signed-up player whose
 * account doesn't yet own a building. Shows two synced views of
 * the city:
 *
 *   1. A top-down mini-map at the top — every plot drawn at its
 *      (plot_x, plot_z) coordinates, coloured by availability.
 *      Hovering / clicking a plot focuses it; occupied plots
 *      display their owner's username.
 *   2. A scrollable grid of cards at the bottom — one per
 *      AVAILABLE plot, with size, dimensions, rent & bonus
 *      details, and a Claim button.
 *
 * Trade-offs per plot kind (user-explicit design):
 *   - small  → ×0.6 daily rent · +$5,000 starter cash · 8×8 interior (P3)
 *   - medium → ×1.0 daily rent · +$2,000 starter cash · 10×10 interior (P3)
 *   - large  → ×1.4 daily rent · no bonus · 12×12 interior (P3)
 *
 * The interior-size differences land in P3; rent + starter cash
 * are active now.
 */
export class BuildingPickModal {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly mapEl: SVGSVGElement;
  private readonly cloud: SpacetimeClient;
  private readonly onClaimed: (buildingId: bigint) => void;
  private busy = false;
  private messageEl: HTMLElement;
  private claimingId: bigint | null = null;
  private focusedId: bigint | null = null;

  constructor(parent: HTMLElement, cloud: SpacetimeClient, onClaimed: (buildingId: bigint) => void) {
    this.cloud = cloud;
    this.onClaimed = onClaimed;

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0",
      width: "100vw", height: "100vh",
      display: "flex",
      alignItems: "center", justifyContent: "center",
      background: "linear-gradient(135deg, rgba(70, 110, 150, 0.95) 0%, rgba(40, 70, 110, 0.98) 100%)",
      zIndex: "2000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const card = document.createElement("div");
    Object.assign(card.style, {
      width: "min(820px, calc(100vw - 40px))",
      maxHeight: "92vh",
      display: "flex", flexDirection: "column",
      padding: "20px 24px",
      background: "rgba(28, 20, 14, 0.98)",
      color: "#fff5dc",
      font: "13px/1.5 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 12px 40px rgba(0,0,0,0.8)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(card);

    const title = document.createElement("div");
    title.textContent = "🏠 PICK YOUR BUILDING";
    Object.assign(title.style, {
      fontSize: "18px", fontWeight: "700", letterSpacing: "0.06em", marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(title);
    const subtitle = document.createElement("div");
    subtitle.textContent = "Tap a plot on the map or click an open card. Plot size changes rent + starter cash.";
    Object.assign(subtitle.style, { fontSize: "12px", opacity: "0.7", marginBottom: "12px" } as Partial<CSSStyleDeclaration>);
    card.appendChild(subtitle);

    // Trade-off legend.
    const legend = document.createElement("div");
    Object.assign(legend.style, {
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gap: "6px",
      marginBottom: "12px",
      fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    const legendCard = (icon: string, kind: string, rent: string, bonus: string, interior: string, hex: string): HTMLElement => {
      const el = document.createElement("div");
      el.innerHTML =
        `<div style="font-weight:600;margin-bottom:2px"><span style="color:${hex}">${icon}</span> ${kind}</div>` +
        `<div style="opacity:0.75">Rent ${rent} · ${bonus}</div>` +
        `<div style="opacity:0.55;font-size:10px">${interior}</div>`;
      Object.assign(el.style, {
        padding: "6px 8px",
        background: "rgba(255,245,220,0.04)",
        borderLeft: `3px solid ${hex}`,
        borderRadius: "3px",
      } as Partial<CSSStyleDeclaration>);
      return el;
    };
    // Starter-cash amounts MUST match Engine.enterGame's grant
    // (small $1,000 / medium $1,500 / large $2,000) — the UI used to
    // advertise inverted $6k/$4k/$2k that the code never paid.
    legend.appendChild(legendCard("🏠", "Small", "×0.6", "+$1,000", "8×8 interior (later)", "#9bd4ff"));
    legend.appendChild(legendCard("🏢", "Medium", "×1.0", "+$1,500", "10×10 interior (now)", "#f0d484"));
    legend.appendChild(legendCard("🏛️", "Large", "×1.4", "+$2,000", "12×12 interior (later)", "#f4a878"));
    card.appendChild(legend);

    // === Mini-map ===
    const mapWrap = document.createElement("div");
    Object.assign(mapWrap.style, {
      width: "100%", height: "260px",
      background: "rgba(255,245,220,0.03)",
      borderRadius: "6px",
      marginBottom: "12px",
      position: "relative",
      overflow: "hidden",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(mapWrap);
    this.mapEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.mapEl.setAttribute("viewBox", "-60 -60 120 120");
    this.mapEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    Object.assign(this.mapEl.style, {
      width: "100%", height: "100%", display: "block",
    } as Partial<CSSStyleDeclaration>);
    mapWrap.appendChild(this.mapEl);

    // === Card list (available plots only) ===
    this.listEl = document.createElement("div");
    Object.assign(this.listEl.style, {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
      gap: "10px",
      overflowY: "auto",
      flex: "1",
      paddingRight: "4px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.listEl);

    this.messageEl = document.createElement("div");
    Object.assign(this.messageEl.style, {
      marginTop: "12px",
      padding: "8px 10px",
      background: "rgba(255,245,220,0.05)",
      borderRadius: "4px",
      fontSize: "12px",
      opacity: "0.85",
      display: "none",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.messageEl);

    this.render();

    // Live refresh — 2 Hz so concurrent claims by other players
    // remove options without waiting for a manual reload.
    const tick = (): void => {
      if (!document.body.contains(this.root)) return;
      this.render();
      window.setTimeout(tick, 500);
    };
    window.setTimeout(tick, 500);
  }

  private render(): void {
    this.renderMap();
    this.renderCards();
  }

  private renderMap(): void {
    // Clear + redraw.
    while (this.mapEl.firstChild) this.mapEl.removeChild(this.mapEl.firstChild);
    const all = this.cloud.listBuildings();
    const accounts = this.cloud.listAccounts();
    const ownerByHex = new Map<string, string>();
    for (const a of accounts) ownerByHex.set(a.identity.toHexString(), a.displayName);

    // Faint background grid lines so coordinates read as a city.
    for (let v = -48; v <= 48; v += 24) {
      const ns = "http://www.w3.org/2000/svg";
      const vLine = document.createElementNS(ns, "line");
      vLine.setAttribute("x1", String(v)); vLine.setAttribute("x2", String(v));
      vLine.setAttribute("y1", "-60"); vLine.setAttribute("y2", "60");
      vLine.setAttribute("stroke", "rgba(255,245,220,0.06)");
      vLine.setAttribute("stroke-width", "0.3");
      this.mapEl.appendChild(vLine);
      const hLine = document.createElementNS(ns, "line");
      hLine.setAttribute("y1", String(v)); hLine.setAttribute("y2", String(v));
      hLine.setAttribute("x1", "-60"); hLine.setAttribute("x2", "60");
      hLine.setAttribute("stroke", "rgba(255,245,220,0.06)");
      hLine.setAttribute("stroke-width", "0.3");
      this.mapEl.appendChild(hLine);
    }

    for (const b of all) {
      const ns = "http://www.w3.org/2000/svg";
      const g = document.createElementNS(ns, "g");
      g.style.cursor = b.isUnowned ? "pointer" : "default";
      const isFocused = this.focusedId === b.id;
      const rect = document.createElementNS(ns, "rect");
      const x = b.plotX - b.plotW / 2;
      const y = b.plotZ - b.plotH / 2;
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(b.plotW));
      rect.setAttribute("height", String(b.plotH));
      rect.setAttribute("rx", "0.4");
      const fillByKind = b.kind === "small" ? "#9bd4ff" : b.kind === "medium" ? "#f0d484" : "#f4a878";
      const fill = b.isUnowned ? fillByKind : "#5c5048";
      rect.setAttribute("fill", fill);
      rect.setAttribute("fill-opacity", b.isUnowned ? (isFocused ? "0.95" : "0.7") : "0.35");
      rect.setAttribute("stroke", isFocused ? "#fff5dc" : "rgba(28,20,14,0.6)");
      rect.setAttribute("stroke-width", isFocused ? "0.6" : "0.25");
      g.appendChild(rect);

      // Owner label for claimed plots.
      if (!b.isUnowned) {
        const ownerName = ownerByHex.get(b.ownerIdentity.toHexString()) ?? "occupied";
        const text = document.createElementNS(ns, "text");
        text.setAttribute("x", String(b.plotX));
        text.setAttribute("y", String(b.plotZ + 1.2));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", "3.5");
        text.setAttribute("fill", "#fff5dc");
        text.setAttribute("fill-opacity", "0.75");
        text.textContent = ownerName;
        g.appendChild(text);
      } else {
        // Number for unowned plots so they're easy to reference.
        const text = document.createElementNS(ns, "text");
        text.setAttribute("x", String(b.plotX));
        text.setAttribute("y", String(b.plotZ + 1.2));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", "3.5");
        text.setAttribute("fill", "#1c140e");
        text.setAttribute("font-weight", "700");
        text.textContent = `#${b.id}`;
        g.appendChild(text);
      }

      g.addEventListener("mouseenter", () => {
        if (b.isUnowned && this.focusedId !== b.id) {
          this.focusedId = b.id;
          this.render();
        }
      });
      g.addEventListener("click", () => {
        if (b.isUnowned && !this.busy) {
          this.claim(b.id);
        }
      });
      this.mapEl.appendChild(g);
    }
  }

  private renderCards(): void {
    this.listEl.innerHTML = "";
    const all = this.cloud.listBuildings();
    const unowned = all.filter((b) => b.isUnowned);
    if (all.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "Loading city map…";
      Object.assign(empty.style, { gridColumn: "1 / -1", opacity: "0.6", textAlign: "center", padding: "30px" } as Partial<CSSStyleDeclaration>);
      this.listEl.appendChild(empty);
      return;
    }
    if (unowned.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "Every plot on this server is taken. Try again later or contact the admin.";
      Object.assign(empty.style, { gridColumn: "1 / -1", opacity: "0.75", textAlign: "center", padding: "30px" } as Partial<CSSStyleDeclaration>);
      this.listEl.appendChild(empty);
      return;
    }
    const order = (k: string): number => (k === "small" ? 0 : k === "medium" ? 1 : 2);
    unowned.sort((a, b) => order(a.kind) - order(b.kind) || Number(a.id - b.id));
    for (const b of unowned) {
      const cardEl = document.createElement("div");
      const focused = this.focusedId === b.id;
      Object.assign(cardEl.style, {
        padding: "10px 12px",
        background: focused ? "rgba(216, 185, 143, 0.16)" : "rgba(255,245,220,0.04)",
        border: focused ? "1px solid #d8b98f" : "1px solid rgba(255,245,220,0.22)",
        borderRadius: "6px",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        cursor: "pointer",
      } as Partial<CSSStyleDeclaration>);
      const icon = b.kind === "small" ? "🏠" : b.kind === "medium" ? "🏢" : "🏛️";
      const kindLabel = b.kind.charAt(0).toUpperCase() + b.kind.slice(1);
      const heading = document.createElement("div");
      heading.innerHTML = `<span style="font-size:18px;margin-right:6px">${icon}</span><b>${kindLabel}</b> <span style="opacity:0.55;font-size:11px">#${b.id}</span>`;
      cardEl.appendChild(heading);

      const meta = document.createElement("div");
      meta.style.opacity = "0.7";
      meta.style.fontSize = "11px";
      meta.textContent = `${b.plotW} × ${b.plotH} tiles · plot (${b.plotX}, ${b.plotZ})`;
      cardEl.appendChild(meta);

      const tradeoff = document.createElement("div");
      tradeoff.style.fontSize = "10px";
      tradeoff.style.opacity = "0.75";
      const rentText = b.kind === "small" ? "Rent ×0.6" : b.kind === "large" ? "Rent ×1.4" : "Rent ×1.0";
      const bonusText = b.kind === "small" ? "+$1,000 starter" : b.kind === "medium" ? "+$1,500 starter" : "+$2,000 starter";
      tradeoff.textContent = `${rentText} · ${bonusText}`;
      cardEl.appendChild(tradeoff);

      const btn = document.createElement("button");
      btn.textContent = this.claimingId === b.id ? "Claiming…" : "Claim this plot";
      Object.assign(btn.style, {
        marginTop: "6px",
        padding: "8px 10px",
        background: "rgba(216, 185, 143, 0.25)",
        color: "#fff5dc",
        border: "1px solid #d8b98f",
        borderRadius: "4px",
        cursor: this.busy ? "default" : "pointer",
        font: "inherit", fontSize: "12px",
        fontWeight: "600",
        opacity: this.busy ? "0.5" : "1",
      } as Partial<CSSStyleDeclaration>);
      btn.disabled = this.busy;
      btn.onclick = (e) => { e.stopPropagation(); this.claim(b.id); };
      cardEl.appendChild(btn);

      cardEl.onmouseenter = () => {
        if (this.focusedId !== b.id) {
          this.focusedId = b.id;
          this.render();
        }
      };

      this.listEl.appendChild(cardEl);
    }
  }

  /** Remove the picker from the DOM. Called by the boot flow when the
   * player's building + restaurant rows finally land AFTER the picker was
   * shown (a slow big-restaurant subscription), so a returning player isn't
   * stranded on "pick a building" with their restaurant already loaded. */
  destroy(): void {
    try { this.root.remove(); } catch { /* already gone */ }
  }

  private async claim(buildingId: bigint): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.claimingId = buildingId;
    this.flash(`Claiming building #${buildingId}…`);
    this.render();
    try {
      await this.cloud.claimBuilding(buildingId);
      await new Promise((r) => setTimeout(r, 100));
      const mine = this.cloud.getMyBuilding();
      if (mine && mine.id === buildingId) {
        this.flash("Building claimed! Loading your restaurant…", "success");
        setTimeout(() => {
          try { this.root.remove(); } catch { /* ignore */ }
          this.onClaimed(buildingId);
        }, 500);
      } else {
        this.flash("Claim didn't register — please try another plot.", "error");
        this.busy = false;
        this.claimingId = null;
        this.render();
      }
    } catch (e) {
      this.flash(e instanceof Error ? e.message : String(e), "error");
      this.busy = false;
      this.claimingId = null;
      this.render();
    }
  }

  private flash(text: string, kind: "info" | "error" | "success" = "info"): void {
    this.messageEl.textContent = text;
    this.messageEl.style.display = "block";
    const tint =
      kind === "error" ? "rgba(255, 154, 154, 0.95)" :
      kind === "success" ? "rgba(168, 226, 168, 0.95)" :
      "rgba(255, 245, 220, 0.75)";
    this.messageEl.style.color = tint;
    this.messageEl.style.borderLeft = `3px solid ${tint}`;
  }
}
