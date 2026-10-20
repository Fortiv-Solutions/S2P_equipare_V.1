/**
 * Landed-cost arithmetic (FR-CMP-02, AC-CMP-02). Pure functions so the formula can be tested exactly.
 *
 *   Taxable = P(1 − d)q + F + K
 *   Landed  = Taxable(1 + γG) − PTA − LD − RD
 *   Unit landed = Landed / q            (all outputs rounded to 2 decimals)
 *
 * γ = 1 when GST is a cost (ITC not available), 0 when recoverable (DEC-21).
 * PTA = Taxable × cost-of-money × (vendor credit days − reference days) / 365, only when enabled (DEC-21).
 * LD / RD = approved late / risk discount amounts (DEC-18). Freight and packing are taxable [ASM].
 */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LandedInput {
  /** Basic unit price P (₹). */
  P: number;
  /** Discount d in percent (0–100). */
  d: number;
  /** Quantity q. */
  q: number;
  /** Freight F (line total, ₹) — already includes any Ex-Works estimate. */
  F: number;
  /** Packing / forwarding K (line total, ₹). */
  K: number;
  /** GST rate G in percent. */
  G: number;
  /** GST impact factor γ (0 or 1). */
  gamma: number;
  /** Payment-term adjustment parameters (off unless enabled). */
  pta?: { enabled: boolean; rate_pct: number; reference_days: number; credit_days: number | null };
  /** Approved late discount amount (₹). */
  LD?: number;
  /** Approved risk discount amount (₹). */
  RD?: number;
}

export interface LandedResult {
  net_unit: number;
  basic_value: number;
  taxable: number;
  gst_amount: number;
  gst_impact: number;
  pta: number;
  ld: number;
  rd: number;
  landed_before_discounts: number;
  landed: number;
  unit_landed: number;
}

export function landedCost(i: LandedInput): LandedResult {
  const q = i.q > 0 ? i.q : 1;
  const net = i.P * (1 - i.d / 100);
  const basic = net * q;
  const taxable = basic + (i.F || 0) + (i.K || 0);
  const gstAmount = taxable * (i.G / 100);
  const gstImpact = taxable * i.gamma * (i.G / 100);
  const pta = i.pta?.enabled && i.pta.credit_days != null ? taxable * (i.pta.rate_pct / 100) * ((i.pta.credit_days - i.pta.reference_days) / 365) : 0;
  const ld = i.LD ?? 0;
  const rd = i.RD ?? 0;
  const before = taxable + gstImpact - pta;
  const landed = before - ld - rd;
  return {
    net_unit: round2(net),
    basic_value: round2(basic),
    taxable: round2(taxable),
    gst_amount: round2(gstAmount),
    gst_impact: round2(gstImpact),
    pta: round2(pta),
    ld: round2(ld),
    rd: round2(rd),
    landed_before_discounts: round2(before),
    landed: round2(landed),
    unit_landed: round2(landed / q),
  };
}

/** Variance of `value` against a reference, as a fraction (0.05 = 5% above). */
export const variance = (value: number | null | undefined, ref: number | null | undefined) =>
  value == null || !ref ? null : Math.round(((value - ref) / ref) * 10000) / 10000;
