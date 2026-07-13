/**
 * Shared player-action menu. Opened by clicking (left OR right) a player name
 * in the roster or chat. Offers: view profile, message (PM), visit, add friend.
 * The host (Engine) supplies the action callbacks so this module stays UI-only.
 */

export interface PlayerMenuActions {
  /** Open a PM conversation with the player. */
  onMessage?: (hex: string, name: string) => void;
  /** Send a friend request. */
  onAddFriend?: (hex: string) => void;
  /** True if already friends (shows a disabled "Friends" row instead). */
  isFriend?: (hex: string) => boolean;
  /** Open the player's profile card. */
  onProfile?: (hex: string) => void;
  /** Enter visit mode for the player's restaurant; returns false if not nearby. */
  onVisit?: (hex: string) => boolean;
}

const MENU_ID = "cb-player-menu";
let activeDismiss: ((ev: Event) => void) | null = null;

export function hidePlayerMenu(): void {
  if (activeDismiss) {
    window.removeEventListener("mousedown", activeDismiss, true);
    activeDismiss = null;
  }
  document.getElementById(MENU_ID)?.remove();
}

export function showPlayerMenu(
  x: number, y: number, hex: string, name: string, isMe: boolean, actions: PlayerMenuActions,
): void {
  hidePlayerMenu();
  const menu = document.createElement("div");
  menu.id = MENU_ID;
  Object.assign(menu.style, {
    position: "fixed", zIndex: "2000",
    background: "rgba(28,20,14,0.98)", color: "#fff5dc",
    border: "1px solid rgba(255,220,150,0.4)", borderRadius: "8px",
    padding: "4px", minWidth: "150px",
    font: "13px/1.3 system-ui, sans-serif",
    boxShadow: "0 6px 22px rgba(0,0,0,0.55)", pointerEvents: "auto",
  } as Partial<CSSStyleDeclaration>);

  const head = document.createElement("div");
  head.textContent = name + (isMe ? " (you)" : "");
  Object.assign(head.style, {
    fontWeight: "700", padding: "5px 10px 6px",
    borderBottom: "1px solid rgba(255,245,220,0.14)", marginBottom: "3px",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "220px",
  } as Partial<CSSStyleDeclaration>);
  menu.appendChild(head);

  const addItem = (label: string, onClick: () => void): void => {
    const item = document.createElement("div");
    item.textContent = label;
    Object.assign(item.style, {
      padding: "6px 10px", borderRadius: "5px", cursor: "pointer", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    item.addEventListener("mouseenter", () => { item.style.background = "rgba(255,245,220,0.10)"; });
    item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
    item.addEventListener("click", () => { hidePlayerMenu(); onClick(); });
    menu.appendChild(item);
  };

  if (actions.onProfile) addItem("👤 View profile", () => actions.onProfile!(hex));
  if (!isMe) {
    if (actions.onMessage) addItem("💬 Message", () => actions.onMessage!(hex, name));
    if (actions.onVisit) addItem("🏃 Visit restaurant", () => { actions.onVisit!(hex); });
    if (actions.onAddFriend) {
      const friend = actions.isFriend?.(hex) ?? false;
      if (friend) {
        const f = document.createElement("div");
        f.textContent = "✓ Friends";
        Object.assign(f.style, { padding: "6px 10px", color: "#a8e2a8", cursor: "default" } as Partial<CSSStyleDeclaration>);
        menu.appendChild(f);
      } else {
        addItem("＋ Add friend", () => actions.onAddFriend!(hex));
      }
    }
  }

  document.body.appendChild(menu);
  // Clamp to the viewport.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 8))}px`;

  // Dismiss on any mousedown outside the menu (capture phase so it beats other
  // handlers). Registered next tick so the opening click doesn't instantly close it.
  const dismiss = (ev: Event): void => {
    if (menu.contains(ev.target as Node)) return;
    hidePlayerMenu();
  };
  activeDismiss = dismiss;
  setTimeout(() => window.addEventListener("mousedown", dismiss, true), 0);
}
