import { defineConfig } from "vite";

// The old 2D game is now PARKED at https://cozy-bistro.com/classic/ (the 3D game
// took over the site root). Asset URLs need the /classic/ prefix in production.
// Local dev (vite dev / preview) serves from "/" and is unaffected because Vite
// only applies `base` in production builds.
export default defineConfig({
  base: "/classic/",
  server: {
    port: 5173,
  },
});
