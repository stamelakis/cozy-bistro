import type { SpacetimeClient } from "../cloud/SpacetimeClient";

/**
 * Authentication gate — full-screen modal shown until the player
 * either signs up or logs in. Three tabs:
 *   - Log in: existing username + password.
 *   - Sign up: new username + password (first "Dunnin" gets admin).
 *   - Forgot: username + free-text message; opens a support ticket
 *     the admin can resolve via the AdminPanel.
 *
 * Doesn't let the player dismiss without authenticating — clicking
 * outside the card or hitting Esc is intentionally ignored. The
 * Engine renders the rest of the game only after onAuthenticated
 * fires.
 */

type Tab = "login" | "signup" | "forgot";

export class LoginModal {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly cloud: SpacetimeClient;
  private readonly onAuthenticated: () => void;
  private tab: Tab = "login";
  private busy = false;
  private message = "";
  private messageKind: "info" | "error" | "success" = "info";

  /** When `startHidden` is true the modal mounts off-screen and stays
   * out of the layout until `show()` is called. Engine uses this to
   * pre-build the modal but only reveal it AFTER a short polling
   * window confirms the player isn't already authenticated — that
   * eliminates the "login screen flashes for 1 second on reload"
   * visual that otherwise happens because the auth_record cache
   * takes a moment to land after connect. */
  constructor(parent: HTMLElement, cloud: SpacetimeClient, onAuthenticated: () => void, startHidden = false) {
    this.cloud = cloud;
    this.onAuthenticated = onAuthenticated;

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0",
      width: "100vw", height: "100vh",
      display: startHidden ? "none" : "flex",
      alignItems: "center", justifyContent: "center",
      // Cozy bistro mood: warm dark amber wash so the login screen
      // doesn't feel like a sterile auth page in a different game.
      background: "linear-gradient(135deg, rgba(40, 24, 14, 0.96) 0%, rgba(20, 12, 8, 0.98) 100%)",
      zIndex: "2000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    // Deliberately NO click-outside-to-dismiss handler — this modal
    // is the gate; the player has to choose a path through it.
    parent.appendChild(this.root);

    const card = document.createElement("div");
    Object.assign(card.style, {
      width: "min(420px, calc(100vw - 40px))",
      padding: "24px 28px",
      background: "rgba(28, 20, 14, 0.98)",
      color: "#fff5dc",
      font: "13px/1.5 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 12px 40px rgba(0,0,0,0.8)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(card);

    // Title — game brand.
    const brand = document.createElement("div");
    brand.textContent = "🍴 COZY BISTRO";
    Object.assign(brand.style, {
      fontSize: "20px",
      fontWeight: "700",
      letterSpacing: "0.06em",
      textAlign: "center",
      marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(brand);
    const subtitle = document.createElement("div");
    subtitle.textContent = "log in to start cooking";
    Object.assign(subtitle.style, {
      fontSize: "11px",
      textAlign: "center",
      opacity: "0.65",
      marginBottom: "18px",
      letterSpacing: "0.04em",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(subtitle);

    // Tab strip.
    const tabs = document.createElement("div");
    Object.assign(tabs.style, {
      display: "flex", gap: "4px", marginBottom: "14px",
    } as Partial<CSSStyleDeclaration>);
    const tabList: { id: Tab; label: string }[] = [
      { id: "login",  label: "Log in" },
      { id: "signup", label: "Sign up" },
      { id: "forgot", label: "Forgot?" },
    ];
    for (const t of tabList) {
      const btn = document.createElement("button");
      btn.textContent = t.label;
      Object.assign(btn.style, {
        flex: "1",
        padding: "8px 10px",
        background: "rgba(255,245,220,0.06)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px",
        cursor: "pointer", font: "inherit", fontSize: "12px",
        fontWeight: "600",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => {
        if (this.busy) return;
        this.tab = t.id;
        this.message = "";
        this.render();
      };
      btn.dataset.tabId = t.id;
      tabs.appendChild(btn);
    }
    card.appendChild(tabs);

    this.body = document.createElement("div");
    card.appendChild(this.body);

    this.render();
  }

  private render(): void {
    // Refresh tab button styles to reflect the active one.
    const tabs = this.root.querySelectorAll<HTMLButtonElement>("button[data-tab-id]");
    for (const btn of Array.from(tabs)) {
      const active = btn.dataset.tabId === this.tab;
      btn.style.background = active ? "rgba(216, 185, 143, 0.25)" : "rgba(255,245,220,0.06)";
      btn.style.borderColor = active ? "#d8b98f" : "rgba(255,245,220,0.18)";
    }

    this.body.innerHTML = "";
    if (this.tab === "login") this.renderLogin();
    else if (this.tab === "signup") this.renderSignup();
    else this.renderForgot();

    if (this.message) {
      const msg = document.createElement("div");
      msg.textContent = this.message;
      const tint =
        this.messageKind === "error"   ? "rgba(255, 154, 154, 0.95)" :
        this.messageKind === "success" ? "rgba(168, 226, 168, 0.95)" :
                                         "rgba(255, 245, 220, 0.75)";
      Object.assign(msg.style, {
        marginTop: "12px",
        padding: "8px 10px",
        background: "rgba(255,245,220,0.05)",
        border: `1px solid ${tint}`,
        borderRadius: "4px",
        color: tint,
        fontSize: "12px",
      } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(msg);
    }
  }

  private renderLogin(): void {
    const desc = document.createElement("div");
    desc.textContent = "Welcome back. Enter your credentials below.";
    Object.assign(desc.style, { fontSize: "12px", opacity: "0.75", marginBottom: "14px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(desc);

    const userInput = this.makeInput("Username", "username", false);
    const passInput = this.makeInput("Password", "current-password", true);
    this.body.appendChild(userInput.wrap);
    this.body.appendChild(passInput.wrap);

    const remember = this.makeRememberMeRow();
    this.body.appendChild(remember.wrap);

    const submit = this.makePrimaryButton("Log in");
    submit.onclick = async () => {
      const u = userInput.input.value.trim();
      const p = passInput.input.value;
      if (!u || !p) {
        this.flash("Username and password are required", "error");
        return;
      }
      this.setBusy(true, "Logging in…");
      try {
        await this.cloud.login(u, p, remember.checkbox.checked);
        if (this.cloud.isAuthenticated()) {
          this.flash("Welcome back!", "success");
          this.dismiss();
        } else {
          this.flash("Login failed — please try again", "error");
        }
      } catch (e) {
        this.flash(humanError(e), "error");
      } finally {
        this.setBusy(false);
      }
    };
    this.body.appendChild(submit);
  }

  private renderSignup(): void {
    const desc = document.createElement("div");
    desc.innerHTML = "Pick a username (3-20 chars, letters/numbers/_/-)<br>and a password (at least 6 chars).";
    Object.assign(desc.style, { fontSize: "12px", opacity: "0.75", marginBottom: "14px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(desc);

    const userInput = this.makeInput("Username", "username", false);
    const passInput = this.makeInput("Password", "new-password", true);
    this.body.appendChild(userInput.wrap);
    this.body.appendChild(passInput.wrap);

    const remember = this.makeRememberMeRow();
    this.body.appendChild(remember.wrap);

    const submit = this.makePrimaryButton("Create account");
    submit.onclick = async () => {
      const u = userInput.input.value.trim();
      const p = passInput.input.value;
      if (!u || !p) {
        this.flash("Username and password are required", "error");
        return;
      }
      this.setBusy(true, "Creating account…");
      try {
        await this.cloud.signUp(u, p, remember.checkbox.checked);
        if (this.cloud.isAuthenticated()) {
          this.flash("Account created. Welcome!", "success");
          this.dismiss();
        } else {
          this.flash("Sign-up failed — please try again", "error");
        }
      } catch (e) {
        this.flash(humanError(e), "error");
      } finally {
        this.setBusy(false);
      }
    };
    this.body.appendChild(submit);
  }

  private renderForgot(): void {
    const desc = document.createElement("div");
    desc.innerHTML =
      "Lost your password or unsure of your username? Tell us what you remember and the admin will reach out to help reset.";
    Object.assign(desc.style, { fontSize: "12px", opacity: "0.75", marginBottom: "14px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(desc);

    const userInput = this.makeInput("Username (best guess)", "username", false);
    this.body.appendChild(userInput.wrap);

    const msgWrap = document.createElement("label");
    Object.assign(msgWrap.style, {
      display: "block", marginBottom: "10px",
      fontSize: "11px", opacity: "0.75",
    } as Partial<CSSStyleDeclaration>);
    msgWrap.textContent = "What happened?";
    const msgArea = document.createElement("textarea");
    msgArea.placeholder = "Tell us anything that might help confirm it's you (e.g. when you signed up, restaurant name).";
    msgArea.rows = 4;
    Object.assign(msgArea.style, {
      display: "block",
      width: "100%",
      marginTop: "4px",
      padding: "8px 10px",
      background: "rgba(255,245,220,0.05)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "4px",
      font: "inherit", fontSize: "12px",
      resize: "vertical",
      boxSizing: "border-box",
    } as Partial<CSSStyleDeclaration>);
    msgWrap.appendChild(msgArea);
    this.body.appendChild(msgWrap);

    const submit = this.makePrimaryButton("Send to admin");
    submit.onclick = async () => {
      const u = userInput.input.value.trim();
      const m = msgArea.value.trim();
      if (!u) {
        this.flash("Please enter a username (your best guess is fine)", "error");
        return;
      }
      this.setBusy(true, "Sending…");
      try {
        await this.cloud.requestPasswordReset(u, m);
        this.flash(
          "Sent. The admin will get back to you out-of-band with a new password. " +
          "Once you have it, come back and Log in.",
          "success",
        );
      } catch (e) {
        this.flash(humanError(e), "error");
      } finally {
        this.setBusy(false);
      }
    };
    this.body.appendChild(submit);
  }

  // ============================================================================
  //                                FORM HELPERS
  // ============================================================================

  private makeInput(label: string, autocomplete: string, isPassword: boolean): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = document.createElement("label");
    Object.assign(wrap.style, {
      display: "block",
      marginBottom: "10px",
      fontSize: "11px",
      opacity: "0.75",
    } as Partial<CSSStyleDeclaration>);
    wrap.textContent = label;
    const input = document.createElement("input");
    input.type = isPassword ? "password" : "text";
    input.autocomplete = autocomplete as AutoFill;
    Object.assign(input.style, {
      display: "block",
      width: "100%",
      marginTop: "4px",
      padding: "8px 10px",
      background: "rgba(255,245,220,0.05)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "4px",
      font: "inherit",
      fontSize: "13px",
      boxSizing: "border-box",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(input);
    return { wrap, input };
  }

  /** Build the "Remember me" checkbox row that sits between the
   * password field and the submit button. Checkbox default is
   * CHECKED to match common-case expectations (most players will
   * want their identity persisted across browser restarts). When
   * unchecked, the SpacetimeClient writes the identity token to
   * sessionStorage instead of localStorage — a tab close clears it
   * and the next visit triggers a fresh login. */
  private makeRememberMeRow(): { wrap: HTMLElement; checkbox: HTMLInputElement } {
    const wrap = document.createElement("label");
    Object.assign(wrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      margin: "4px 0 14px 0",
      fontSize: "12px",
      cursor: "pointer",
      userSelect: "none",
    } as Partial<CSSStyleDeclaration>);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    Object.assign(checkbox.style, {
      width: "14px", height: "14px",
      accentColor: "#d8b98f",
      cursor: "pointer",
      margin: "0",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(checkbox);
    const text = document.createElement("span");
    text.textContent = "Remember me on this device";
    Object.assign(text.style, {
      opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(text);
    return { wrap, checkbox };
  }

  private makePrimaryButton(label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    Object.assign(btn.style, {
      display: "block",
      width: "100%",
      marginTop: "6px",
      padding: "10px 12px",
      background: "rgba(216, 185, 143, 0.25)",
      color: "#fff5dc",
      border: "1px solid #d8b98f",
      borderRadius: "6px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "13px",
      fontWeight: "700",
      letterSpacing: "0.04em",
    } as Partial<CSSStyleDeclaration>);
    return btn;
  }

  private flash(text: string, kind: "info" | "error" | "success" = "info"): void {
    this.message = text;
    this.messageKind = kind;
    this.render();
  }

  private setBusy(busy: boolean, text?: string): void {
    this.busy = busy;
    if (text !== undefined) {
      this.message = text;
      this.messageKind = "info";
    }
    // Disable all interactive elements while busy.
    const allButtons = this.root.querySelectorAll("button");
    const allInputs = this.root.querySelectorAll("input, textarea");
    for (const el of Array.from(allButtons)) (el as HTMLButtonElement).disabled = busy;
    for (const el of Array.from(allInputs)) (el as HTMLInputElement | HTMLTextAreaElement).disabled = busy;
  }

  private dismiss(): void {
    // Small delay so the success flash is visible.
    setTimeout(() => {
      this.root.style.display = "none";
      try { this.root.remove(); } catch { /* ignore */ }
      this.onAuthenticated();
    }, 600);
  }

  /** Reveal a modal that was constructed with `startHidden = true`.
   * Idempotent — calling it on an already-visible modal is a no-op. */
  show(): void {
    if (this.root.style.display !== "none") return;
    this.root.style.display = "flex";
  }

  /** Detach the modal from the DOM without firing onAuthenticated.
   * Used by the engine's auth-gate when an existing identity is
   * detected during the silent polling window — the modal was a
   * placeholder, nothing to dismiss visually. */
  destroy(): void {
    try { this.root.remove(); } catch { /* already gone */ }
  }
}

/** Make SpacetimeDB error strings player-friendly. */
function humanError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong. Please try again.";
}
