/**
 * Shared confirm card — a small in-app "are you sure?" for actions that spend
 * money or can't be undone (hiring someone onto the payroll, firing them and
 * losing their training). Matches the tier-gate card so every decision point in
 * the game looks the same, instead of a system `window.confirm` box.
 *
 * `danger: true` paints the primary button red for destructive actions.
 */
export function confirmAction(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}): void {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", display: "flex",
    alignItems: "center", justifyContent: "center",
    // Non-zero RGB so MobileUI's black-backdrop modal tagger skips this small
    // transient card (it isn't a scrollable modal).
    background: "rgba(8,5,3,0.5)", zIndex: "4100", padding: "20px",
  } as Partial<CSSStyleDeclaration>);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const card = document.createElement("div");
  Object.assign(card.style, {
    boxSizing: "border-box", width: "100%", maxWidth: "330px",
    background: "rgba(34,24,16,0.98)", color: "#fff5dc",
    border: "1px solid #d8b98f", borderRadius: "12px",
    padding: "20px 20px 16px", textAlign: "center",
    font: "13px/1.5 system-ui, sans-serif",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
  } as Partial<CSSStyleDeclaration>);

  const h = document.createElement("div");
  Object.assign(h.style, { fontSize: "16px", fontWeight: "700", marginBottom: "8px" } as Partial<CSSStyleDeclaration>);
  h.textContent = opts.title;
  const p = document.createElement("div");
  Object.assign(p.style, { opacity: "0.9", marginBottom: "16px", whiteSpace: "pre-line" } as Partial<CSSStyleDeclaration>);
  p.textContent = opts.message;

  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", gap: "8px" } as Partial<CSSStyleDeclaration>);

  const mk = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    const bg = primary
      ? (opts.danger ? "rgba(214,90,90,0.95)" : "rgba(120,200,120,0.92)")
      : "transparent";
    Object.assign(b.style, {
      flex: "1", minHeight: "46px", padding: "10px 14px", borderRadius: "8px",
      fontWeight: "700", fontSize: "13px", cursor: "pointer",
      border: primary ? "none" : "1px solid rgba(255,245,220,0.28)",
      background: bg,
      color: primary ? (opts.danger ? "#fff" : "#17240f") : "#fff5dc",
    } as Partial<CSSStyleDeclaration>);
    b.onclick = onClick;
    return b;
  };

  row.appendChild(mk(opts.cancelLabel ?? "Cancel", false, () => overlay.remove()));
  row.appendChild(mk(opts.confirmLabel, true, () => { overlay.remove(); opts.onConfirm(); }));
  card.append(h, p, row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}
