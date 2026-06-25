import { Engine } from "./game/Engine";
import { initMobileUI } from "./ui/MobileUI";

const app = document.getElementById("app");
if (!app) {
  throw new Error("App container #app not found");
}

const engine = new Engine(app);
engine.start();

// Bolt on the mobile / touch layer. No-op on a wide mouse-driven desktop —
// it only activates when the pointer is coarse or the viewport is narrow.
initMobileUI();

// Surface engine in dev for in-browser debugging.
if (import.meta.env.DEV) {
  (window as unknown as { __cozyBistro3D: Engine }).__cozyBistro3D = engine;
}

document.getElementById("loading")?.remove();
