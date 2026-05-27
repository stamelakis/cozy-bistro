import { defineConfig } from "vite";

export default defineConfig({
  // The 2D build deploys to /cozy-bistro/. The 3D build will eventually
  // replace it at the same path, but during co-development we host it at
  // a separate subpath so both can coexist.
  base: "/cozy-bistro-3d/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5180,
  },
});
