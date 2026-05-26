import type { SaveGameState } from "../components/types";

const saveKey = "cozy-bistro-prototype-save";
const slotPrefix = `${saveKey}-slot-`;
const slotCount = 3;

export class SaveSystem {
  save(state: SaveGameState, slot = 1): { bytes: number; durationMs: number } {
    const startedAt = performance.now();
    const serialized = JSON.stringify(state);
    localStorage.setItem(this.getSlotKey(slot), serialized);
    return {
      bytes: serialized.length,
      durationMs: performance.now() - startedAt,
    };
  }

  getSaveSizeBytes(slot = 1): number {
    const rawSave = localStorage.getItem(this.getSlotKey(slot)) ?? (slot === 1 ? localStorage.getItem(saveKey) : null);
    return rawSave?.length ?? 0;
  }

  load(slot = 1): SaveGameState | null {
    const rawSave = localStorage.getItem(this.getSlotKey(slot)) ?? (slot === 1 ? localStorage.getItem(saveKey) : null);
    if (!rawSave) {
      return null;
    }

    try {
      return JSON.parse(rawSave) as SaveGameState;
    } catch {
        localStorage.removeItem(this.getSlotKey(slot));
      return null;
    }
  }

  clear(slot = 1): void {
    localStorage.removeItem(this.getSlotKey(slot));
    if (slot === 1) {
      localStorage.removeItem(saveKey);
    }
  }

  listSlots(): Array<{ slot: number; save: SaveGameState | null }> {
    return Array.from({ length: slotCount }, (_, index) => {
      const slot = index + 1;
      return { slot, save: this.load(slot) };
    });
  }

  private getSlotKey(slot: number): string {
    return `${slotPrefix}${slot}`;
  }
}
