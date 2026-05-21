import type { SaveGameState } from "../components/types";

const saveKey = "cozy-bistro-prototype-save";

export class SaveSystem {
  save(state: SaveGameState): void {
    localStorage.setItem(saveKey, JSON.stringify(state));
  }

  load(): SaveGameState | null {
    const rawSave = localStorage.getItem(saveKey);
    if (!rawSave) {
      return null;
    }

    try {
      return JSON.parse(rawSave) as SaveGameState;
    } catch {
      localStorage.removeItem(saveKey);
      return null;
    }
  }

  clear(): void {
    localStorage.removeItem(saveKey);
  }
}
