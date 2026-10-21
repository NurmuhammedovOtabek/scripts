/**
 * The chamber.uz (savdo palatasi) rating scale: a 0-100 score to its letter
 * grade.
 *
 * This ladder is not new — it is what the company page has always shown. It
 * lived only in the frontend, which derived the letter from the number on
 * every render, while `company_info.trust` held a second copy of the score.
 * Moving it here makes the letter a stored fact rather than a display detail,
 * so every consumer — website, partner API, exports — reads the same grade,
 * and myorg's own letter (which it publishes directly) can sit in the same
 * column without a type clash.
 *
 * Keep in step with `numberToGrade` in the frontend's CompanyHeader, which
 * still converts for any number a cached or third-party payload may carry.
 */
export const RATING_GRADES = [
  { min: 96, grade: 'AAA' },
  { min: 91, grade: 'AA' },
  { min: 86, grade: 'A' },
  { min: 76, grade: 'BBB' },
  { min: 66, grade: 'BB' },
  { min: 56, grade: 'B' },
  { min: 51, grade: 'CCC' },
  { min: 36, grade: 'CC' },
  { min: 26, grade: 'C' },
  { min: -Infinity, grade: 'D' },
] as const;

/** Longest grade is 'AAA' — the column is sized from this. */
export const RATING_GRADE_MAX_LENGTH = 3;

/**
 * Letter grade for a chamber score, or null when there is no score to grade.
 *
 * A score of 0 is a real rating ('D'), not a missing one, so only null,
 * undefined and non-numbers return null.
 */
export function scoreToGrade(score: unknown): string | null {
  const n = typeof score === 'number' ? score : Number(score);
  if (
    score === null ||
    score === undefined ||
    score === '' ||
    !Number.isFinite(n)
  ) {
    return null;
  }
  return RATING_GRADES.find((r) => n >= r.min)!.grade;
}
