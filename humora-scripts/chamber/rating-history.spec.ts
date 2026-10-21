import {
  RECORD_RATING_SQL,
  recordRating,
  touchesRating,
} from './rating-history';

describe('recordRating', () => {
  it('copies the row just written, unless it equals the latest history row', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    await recordRating(db, '300000001');
    expect(db.query).toHaveBeenCalledWith(RECORD_RATING_SQL, ['300000001']);
    expect(RECORD_RATING_SQL).toContain(
      'INSERT INTO public.company_rating_history',
    );
    expect(RECORD_RATING_SQL).toContain('FROM public.company_info ci');
    expect(RECORD_RATING_SQL).toContain(
      'ci.trust IS NOT NULL OR ci.score IS NOT NULL',
    );
    expect(RECORD_RATING_SQL).toContain(
      'last.grade IS NOT DISTINCT FROM ci.trust',
    );
    expect(RECORD_RATING_SQL).toContain(
      'last.score IS NOT DISTINCT FROM ci.score',
    );
  });

  it('asks nothing for an INN that is not nine or fourteen digits', async () => {
    const db = { query: jest.fn() };
    await recordRating(db, '12345');
    await recordRating(db, undefined as unknown as string);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('logs a failure and never throws', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('no table')) };
    const logger = { warn: jest.fn() };
    await expect(
      recordRating(db, '300000001', logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      '[rating-history] 300000001 not recorded: no table',
    );
  });
});

describe('touchesRating', () => {
  it('is true only when trust or score is written', () => {
    expect(touchesRating(['email', 'trust'])).toBe(true);
    expect(touchesRating(['score'])).toBe(true);
    expect(touchesRating(['email', 'is_large_taxpayer'])).toBe(false);
  });
});
