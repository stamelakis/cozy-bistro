import { defineConfig } from "vite";

export default defineConfig({
  // The 2D build deploys to /cozy-bistro/ on GitHub Pages. We host the 3D
  // build as a subpath under it: /cozy-bistro/cozy-bistro-3d/. That way
  // both versions coexist during co-development without needing a second
  // Pages site or domain. For local dev, Vite still serves it at
  // /cozy-bistro-3d/ on the dev server (no /cozy-bistro/ prefix).
  base: process.env.NODE_ENV === "production" ? "/cozy-bistro/cozy-bistro-3d/" : "/cozy-bistro-3d/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5180,
  },
});
