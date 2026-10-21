import { parseBackfillArgs } from './rating-history-backfill';

describe('parseBackfillArgs', () => {
  it('defaults to a real run in batches of 5000', () => {
    expect(parseBackfillArgs([])).toEqual({ dryRun: false, batch: 5000 });
  });

  it('accepts --dry-run and --batch in any order', () => {
    expect(parseBackfillArgs(['--dry-run', '--batch', '250'])).toEqual({
      dryRun: true,
      batch: 250,
    });
    expect(parseBackfillArgs(['--batch', '1', '--dry-run'])).toEqual({
      dryRun: true,
      batch: 1,
    });
  });

  it.each([
    ['--dryrun'],
    ['--dry-run', 'extra'],
    ['stray'],
    ['--batch'],
    ['--batch', '0'],
    ['--batch', '-5'],
    ['--batch', 'abc'],
    ['--batch', '1.5'],
    ['--batch', '10x'],
    ['--batch', '99999999999999999999'],
    ['--batch', '--dry-run'],
  ])('rejects %j', (...argv) => {
    expect(parseBackfillArgs(argv)).toBeNull();
  });
});
