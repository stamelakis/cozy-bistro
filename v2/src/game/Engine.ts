import * as THREE from "three";
import { IsoCamera } from "../scene/IsoCamera";
import { WorldScene } from "../scene/WorldScene";

/** Top-level engine. Owns the renderer, scene, camera, and the main loop. */
export class Engine {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly clock = new THREE.Clock();

  readonly scene: WorldScene;
  readonly camera: IsoCamera;

  private running = false;
  private lastResizeCheckAt = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      // Needed for canvas.toDataURL/snapshot to capture the latest frame.
      // Small perf hit on integrated GPUs but invaluable for tooling.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0xd8c4a3);
    container.appendChild(this.renderer.domElement);

    this.scene = new WorldScene();
    this.camera = new IsoCamera(container.clientWidth, container.clientHeight);
    this.camera.attachInputTo(this.renderer.domElement);

    window.addEventListener("resize", this.handleResize);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.tick();
  }

  stop(): void {
    this.running = false;
  }

  private readonly handleResize = (): void => {
    this.lastResizeCheckAt = performance.now();
  };

  private resizeIfNeeded(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === this.renderer.domElement.width / this.renderer.getPixelRatio() &&
        h === this.renderer.domElement.height / this.renderer.getPixelRatio()) {
      return;
    }
    this.renderer.setSize(w, h);
    this.camera.resize(w, h);
  }

  private tick = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.tick);

    if (performance.now() - this.lastResizeCheckAt < 1000) {
      this.resizeIfNeeded();
    }

    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.scene.update(dt);
    this.camera.update(dt);

    this.renderer.render(this.scene.threeScene, this.camera.threeCamera);
  };
}
