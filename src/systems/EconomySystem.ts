export class EconomySystem {
  private money: number;

  constructor(startingMoney = 280) {
    this.money = startingMoney;
  }

  getMoney(): number {
    return this.money;
  }

  canAfford(amount: number): boolean {
    return this.money >= amount;
  }

  spend(amount: number): boolean {
    if (!this.canAfford(amount)) {
      return false;
    }

    this.money -= amount;
    return true;
  }

  earn(amount: number): void {
    this.money += amount;
  }

  setMoney(amount: number): void {
    this.money = amount;
  }
}
