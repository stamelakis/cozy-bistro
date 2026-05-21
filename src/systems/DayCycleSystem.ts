export class DayCycleSystem {
  private dayNumber: number;
  private elapsedSeconds = 0;
  private readonly dayLengthSeconds: number;

  constructor(dayNumber = 1, dayLengthSeconds = 180) {
    this.dayNumber = dayNumber;
    this.dayLengthSeconds = dayLengthSeconds;
  }

  update(deltaSeconds: number): boolean {
    this.elapsedSeconds += deltaSeconds;
    return this.elapsedSeconds >= this.dayLengthSeconds;
  }

  getDayNumber(): number {
    return this.dayNumber;
  }

  getTimeRemainingSeconds(): number {
    return Math.max(0, this.dayLengthSeconds - this.elapsedSeconds);
  }

  setDayNumber(dayNumber: number): void {
    this.dayNumber = dayNumber;
  }
}
