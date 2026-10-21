/**
 * A legal entity's STIR is not arbitrary: eight digits of one national counter
 * followed by a check digit. Knowing the rule turns "which companies were
 * registered yesterday" — a question no public source answers — into a walk up
 * the counter.
 *
 * The check digit, established on 126,361 stored STIRs with no exception:
 *
 *   S  = 37·d1 + 29·d2 + 23·d3 + 19·d4 + 17·d5 + 13·d6 + 7·d7 + 3·d8
 *   r  = S mod 11
 *   d9 = 9 − r when r ≤ 5, otherwise 10 − r
 *
 * So every sequence number has exactly one valid STIR, and a STIR whose ninth
 * digit disagrees was never issued — there is nothing to look up.
 */
const WEIGHTS = [37, 29, 23, 19, 17, 13, 7, 3];

/** Legal entities are issued 300000000–399999999; 4, 5 and 6 are people. */
export const LEGAL_ENTITY_SEQUENCE = {
  first: 30_000_000,
  last: 39_999_999,
} as const;

export function innCheckDigit(sequence: number): number {
  let rest = sequence;
  let sum = 0;
  for (let i = WEIGHTS.length - 1; i >= 0; i--) {
    sum += (rest % 10) * WEIGHTS[i];
    rest = Math.floor(rest / 10);
  }
  const remainder = sum % 11;
  return remainder <= 5 ? 9 - remainder : 10 - remainder;
}

export function innFromSequence(sequence: number): string {
  if (
    !Number.isInteger(sequence) ||
    sequence < 10_000_000 ||
    sequence > 99_999_999
  ) {
    throw new RangeError(`not an eight-digit STIR sequence: ${sequence}`);
  }
  return `${sequence}${innCheckDigit(sequence)}`;
}

/** The sequence number behind a STIR, or null when the STIR cannot exist. */
export function sequenceOfInn(inn: string | null | undefined): number | null {
  if (typeof inn !== 'string' || !/^\d{9}$/.test(inn)) return null;
  const sequence = Number(inn.slice(0, 8));
  if (sequence < 10_000_000) return null;
  return innCheckDigit(sequence) === Number(inn[8]) ? sequence : null;
}
