/**
 * Environment storage isolation — MUST be imported FIRST in main.ts, before any
 * module (SpacetimeClient, SaveSystem, feature flags, …) touches storage.
 *
 * Prod and staging share the same web origin AND the same SpacetimeDB host, so
 * without this they share localStorage + sessionStorage. That means the local
 * SAVE (furniture layout) and the auth TOKEN (keyed by host, which is identical
 * for both) bleed across — so opening ?env=staging showed the LIVE restaurant's
 * saved layout and logged you in as your prod identity, while the empty staging
 * server had nothing to simulate (staff idle, "tons of bugs").
 *
 * Fix: when on staging, transparently prefix every storage key so staging gets
 * its own isolated slate — fresh save, fresh token → a real staging signup.
 * The `cb_env` selector itself stays global (it decides which env we're in).
 * Prod is completely untouched (the shim only installs on staging).
 */
(function installEnvStorageNamespace(): void {
  try {
    const q = new URLSearchParams(window.location.search).get("env");
    // Env stickiness is SESSION-scoped (per tab), not permanent. The old version
    // stuck the selector in localStorage, so once you opened ?env=staging the
    // *bare prod URL* kept routing to staging forever — prod showed the staging
    // restaurant, and testers landed in the empty staging DB ("can't log in").
    // Scrub any stale localStorage flag and key off sessionStorage: it survives
    // the query-string-dropping login/plot reloads within a tab, but a fresh
    // visit to the prod URL is prod.
    try { window.localStorage.removeItem("cb_env"); } catch { /* ignore */ }
    let onStaging: boolean;
    if (q === "staging") {
      onStaging = true;
      try { window.sessionStorage.setItem("cb_env", "staging"); } catch { /* ignore */ }
    } else if (q === "prod") {
      onStaging = false;
      try { window.sessionStorage.removeItem("cb_env"); } catch { /* ignore */ }
    } else {
      onStaging = window.sessionStorage.getItem("cb_env") === "staging";
    }
    if (!onStaging) return;

    const PREFIX = "stg::";
    const KEEP = new Set(["cb_env"]); // the env selector must remain global
    const nk = (k: string): string => (KEEP.has(k) ? k : PREFIX + k);

    const wrap = (store: Storage): void => {
      const get = store.getItem.bind(store);
      const set = store.setItem.bind(store);
      const rem = store.removeItem.bind(store);
      store.getItem = (k: string): string | null => get(nk(k));
      store.setItem = (k: string, v: string): void => set(nk(k), v);
      store.removeItem = (k: string): void => rem(nk(k));
    };
    wrap(window.localStorage);
    wrap(window.sessionStorage);
  } catch {
    /* storage blocked (private mode) — nothing to isolate */
  }
})();
