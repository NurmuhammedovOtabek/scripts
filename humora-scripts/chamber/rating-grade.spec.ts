import { scoreToGrade } from './rating-grade';

/**
 * The ladder these assert is the one the company page has shown all along —
 * it moved here from the frontend's `numberToGrade`, so the boundaries must
 * still land where a reader has been seeing them.
 */
describe('scoreToGrade — the chamber 0-100 scale', () => {
  it.each([
    [100, 'AAA'],
    [96, 'AAA'],
    [95, 'AA'],
    [91, 'AA'],
    [90, 'A'],
    [86, 'A'],
    [85, 'BBB'],
    [76, 'BBB'],
    [75, 'BB'],
    [66, 'BB'],
    [65, 'B'],
    [56, 'B'],
    [55, 'CCC'],
    [51, 'CCC'],
    [50, 'CC'],
    [36, 'CC'],
    [35, 'C'],
    [26, 'C'],
    [25, 'D'],
    [0, 'D'],
  ])('%i → %s', (score, grade) => {
    expect(scoreToGrade(score)).toBe(grade);
  });

  // 0 is the bottom of the scale, not an absent rating — the distinction the
  // whole fallback chain rests on.
  it('grades a zero rather than calling it missing', () => {
    expect(scoreToGrade(0)).toBe('D');
  });

  it('returns null when there is nothing to grade', () => {
    expect(scoreToGrade(null)).toBeNull();
    expect(scoreToGrade(undefined)).toBeNull();
    expect(scoreToGrade('')).toBeNull();
    expect(scoreToGrade('not a number')).toBeNull();
    expect(scoreToGrade(NaN)).toBeNull();
  });

  // Postgres hands bigint columns back as strings through node-postgres, so a
  // score read from the DB arrives as '77', not 77.
  it('accepts the string a bigint column reads back as', () => {
    expect(scoreToGrade('77')).toBe('BBB');
  });

  // Nothing promises the source stays inside 0-100; clamp by falling off
  // either end of the ladder rather than returning null.
  it('does not fall through for out-of-range scores', () => {
    expect(scoreToGrade(140)).toBe('AAA');
    expect(scoreToGrade(-5)).toBe('D');
  });
});
