import { defineConfig } from "vite";

// Prod build deploys the 3D game to /cozy-bistro/cozy-bistro-3d/ on GitHub
// Pages (a subpath of the 2D build at /cozy-bistro/). The CI staging build
// overrides two env vars so it can ship as a SEPARATE bundle that coexists
// with prod on the same Pages site:
//   CB_BASE=/cozy-bistro/staging/cozy-bistro-3d/  → its own URL subpath
//   CB_BUILD_ENV=staging                          → defaults to the staging DB
// For local dev, Vite serves at /cozy-bistro-3d/ (no /cozy-bistro/ prefix).
const buildEnv = process.env.CB_BUILD_ENV ?? "prod";
export default defineConfig({
  base:
    process.env.CB_BASE ??
    (process.env.NODE_ENV === "production" ? "/cozy-bistro/cozy-bistro-3d/" : "/cozy-bistro-3d/"),
  define: {
    // Compile-time constant read by envStorage + SpacetimeClient so a
    // dedicated staging build points at the staging DB (and isolates its
    // storage + shows the STAGING badge) without needing ?env=staging.
    __CB_ENV__: JSON.stringify(buildEnv),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5180,
  },
});
