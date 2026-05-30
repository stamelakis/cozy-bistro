import type { SpacetimeClient } from "../cloud/SpacetimeClient";

/**
 * Full-screen modal shown to a freshly signed-up player whose
 * account doesn't yet own a building. Lists every unowned plot
 * on the shared city map with a thumbnail-style preview (size +
 * coordinates) and a "claim" button.
 *
 * The current city map seeds 12 buildings of three sizes
 * (small/medium/large) — see spacetime/src/reducers/buildings.rs
 * for the seed layout. The modal renders them in a scrollable
 * grid so the player can browse and pick.
 *
 * On successful claim, the modal dismisses and fires
 * onClaimed(buildingId) so the engine can re-parent the camera
 * to the new plot and lift the auth gate.
 */
export class BuildingPickModal {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly cloud: SpacetimeClient;
  private readonly onClaimed: (buildingId: bigint) => void;
  private busy = false;
  private messageEl: HTMLElement;
  private claimingId: bigint | null = null;

  constructor(parent: HTMLElement, cloud: SpacetimeClient, onClaimed: (buildingId: bigint) => void) {
    this.cloud = cloud;
    this.onClaimed = onClaimed;

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0",
      width: "100vw", height: "100vh",
      display: "flex",
      alignItems: "center", justifyContent: "center",
      // Daytime Mediterranean palette so the building-pick step
      // feels like browsing real-estate on a sunny Greek street.
      background: "linear-gradient(135deg, rgba(70, 110, 150, 0.95) 0%, rgba(40, 70, 110, 0.98) 100%)",
      zIndex: "2000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const card = document.createElement("div");
    Object.assign(card.style, {
      width: "min(720px, calc(100vw - 40px))",
      maxHeight: "88vh",
      display: "flex", flexDirection: "column",
      padding: "22px 26px",
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
      fontSize: "18px",
      fontWeight: "700",
      letterSpacing: "0.06em",
      marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(title);
    const subtitle = document.createElement("div");
    subtitle.textContent = "Choose an empty plot — you'll own it and build your restaurant inside.";
    Object.assign(subtitle.style, {
      fontSize: "12px",
      opacity: "0.7",
      marginBottom: "16px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(subtitle);

    this.listEl = document.createElement("div");
    Object.assign(this.listEl.style, {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
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

    // Poll the live cache — buildings can refresh while modal is up
    // (e.g. another player claims one). 2 Hz is plenty.
    const tick = (): void => {
      if (!document.body.contains(this.root)) return;
      this.render();
      window.setTimeout(tick, 500);
    };
    window.setTimeout(tick, 500);
  }

  private render(): void {
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
    // Order by kind (small / medium / large) then by id for a
    // stable layout each render.
    const order = (k: string): number => (k === "small" ? 0 : k === "medium" ? 1 : 2);
    unowned.sort((a, b) => order(a.kind) - order(b.kind) || Number(a.id - b.id));
    for (const b of unowned) {
      const card = document.createElement("div");
      Object.assign(card.style, {
        padding: "10px 12px",
        background: "rgba(255,245,220,0.04)",
        border: "1px solid rgba(255,245,220,0.22)",
        borderRadius: "6px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      } as Partial<CSSStyleDeclaration>);
      const icon = b.kind === "small" ? "🏠" : b.kind === "medium" ? "🏢" : "🏛️";
      const kindLabel = b.kind.charAt(0).toUpperCase() + b.kind.slice(1);
      const heading = document.createElement("div");
      heading.innerHTML = `<span style="font-size:18px;margin-right:6px">${icon}</span><b>${kindLabel}</b> <span style="opacity:0.55;font-size:11px">#${b.id}</span>`;
      card.appendChild(heading);
      const meta = document.createElement("div");
      meta.style.opacity = "0.7";
      meta.style.fontSize = "11px";
      meta.textContent = `${b.plotW} × ${b.plotH} tiles · plot (${b.plotX}, ${b.plotZ})`;
      card.appendChild(meta);

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
      btn.onclick = () => this.claim(b.id);
      card.appendChild(btn);

      this.listEl.appendChild(card);
    }
  }

  private async claim(buildingId: bigint): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.claimingId = buildingId;
    this.flash(`Claiming building #${buildingId}…`);
    this.render();
    try {
      await this.cloud.claimBuilding(buildingId);
      // Wait one tick so the local cache reflects the new owner
      // before we double-check via getMyBuilding (avoids a race
      // where the reducer applied but onApplied hasn't fired yet).
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
