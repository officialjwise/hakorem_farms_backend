/**
 * Natural logarithm and exponential in fixed point on bigints, thirty decimal places (FR-CAP-014: an internal rate of
 * return without a float, ADR-0001). A value v stands for v / SCALE. Pure.
 */
export const SCALE = 10n ** 30n;
const TWO = 2n * SCALE;

/** ln(m / SCALE) for m in [SCALE, 2 SCALE]: 2 atanh(z), z = (m - 1) / (m + 1) at most one third, so the series is short. */
function lnNearOne(m: bigint): bigint {
  const z = ((m - SCALE) * SCALE) / (m + SCALE);
  const z2 = (z * z) / SCALE;
  let term = z;
  let sum = z;
  let odd = 1n;
  while (term !== 0n) {
    term = (term * z2) / SCALE;
    odd += 2n;
    sum += term / odd;
  }
  return 2n * sum;
}

const LN2 = lnNearOne(TWO);

/** ln(x / SCALE) for x > 0: x = m 2^k with m in [1, 2). */
export function ln(x: bigint): bigint {
  let m = x;
  let k = 0n;
  while (m >= TWO) {
    m /= 2n;
    k += 1n;
  }
  while (m < SCALE) {
    m *= 2n;
    k -= 1n;
  }
  return k * LN2 + lnNearOne(m);
}

/** exp(y / SCALE): y = k ln 2 + r with |r| at most half ln 2, the Taylor series of r, shifted by k. */
export function exp(y: bigint): bigint {
  const half = LN2 / 2n;
  const k = y >= 0n ? (y + half) / LN2 : -((half - y) / LN2);
  const r = y - k * LN2;
  let term = SCALE;
  let sum = SCALE;
  let n = 0n;
  while (term !== 0n) {
    n += 1n;
    term = (term * r) / (SCALE * n);
    sum += term;
  }
  return k >= 0n ? sum << k : sum >> -k;
}
