import { Engine } from "./game/Engine";

const app = document.getElementById("app");
if (!app) {
  throw new Error("App container #app not found");
}

const engine = new Engine(app);
engine.start();

// Surface engine in dev for in-browser debugging.
if (import.meta.env.DEV) {
  (window as unknown as { __cozyBistro3D: Engine }).__cozyBistro3D = engine;
}

document.getElementById("loading")?.remove();
