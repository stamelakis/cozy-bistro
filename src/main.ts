import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";
import "./style.css";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#f7e6c8",
  width: 1600,
  height: 900,
  pixelArt: false,
  roundPixels: false,
  fps: {
    target: 30,
    forceSetTimeOut: true,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [GameScene],
};

const game = new Phaser.Game(config);

if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
  (window as unknown as { __cozyBistroGame?: Phaser.Game }).__cozyBistroGame = game;
}
