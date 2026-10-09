/**
 * Hak harcama ve odul kirpma hesaplari - saf fonksiyonlar, islemin icinde
 * kilitli satirlarin degerleriyle cagrilir.
 */

export interface ChargeSplit {
  fromDaily: number;
  fromBonus: number;
}

/**
 * Once donem hakki, kalani bonus. Yetmezse `null` (hic harcanmaz).
 * `periodRemaining`: haftalik/aylik pencerenin kalani (`QUOTA_POLICY`); donem
 * hakki gunluk kalan ile bunun kucugudur. Verilmezse yalnizca gunluk.
 */
export function splitCharge(input: {
  cost: number;
  dailyLimit: number;
  dailyUsed: number;
  bonusBalance: number;
  periodRemaining?: number;
}): ChargeSplit | null {
  if (!Number.isInteger(input.cost) || input.cost <= 0) {
    throw new Error("maliyet pozitif bir tamsayi olmali");
  }
  const dailyRemaining = Math.min(
    Math.max(0, input.dailyLimit - input.dailyUsed),
    Math.max(0, input.periodRemaining ?? Number.POSITIVE_INFINITY),
  );
  const fromDaily = Math.min(input.cost, dailyRemaining);
  const fromBonus = input.cost - fromDaily;
  if (fromBonus > Math.max(0, input.bonusBalance)) return null;
  return { fromDaily, fromBonus };
}

/** Odulun tavana gore yazilabilecek kismi (0 olabilir). */
export function cappedCredit(input: { amount: number; balance: number; max: number }): number {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("odul pozitif bir tamsayi olmali");
  }
  return Math.max(0, Math.min(input.amount, input.max - input.balance));
}
