import { defineConfig } from "vite";

// Served from https://stamelakis.github.io/cozy-bistro/ in production, so asset URLs
// need the /cozy-bistro/ prefix. Local dev (vite dev / preview) serves from "/" and
// is unaffected because Vite only applies `base` in production builds.
export default defineConfig({
  base: "/cozy-bistro/",
  server: {
    port: 5173,
  },
});
