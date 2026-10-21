import { QueryFailedError } from 'typeorm';
import { listCompanyFromMysoliq } from './company-listing';

/**
 * The other side of the new-company race: a search inserts the same STIR
 * between this listing's NOT EXISTS and its write. The company is there, so
 * the listing wrote nothing — not a failure for the scan to count.
 */
describe('listCompanyFromMysoliq', () => {
  const company = { company_name: 'MChJ «NAMUNA»' } as any;
  const failWith = (code: string) => ({
    query: jest
      .fn()
      .mockRejectedValue(new QueryFailedError('INSERT …', [], { code } as any)),
  });

  it('lists a company nobody holds', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ inn: '399999991' }]) };
    await expect(
      listCompanyFromMysoliq(db, '399999991', company),
    ).resolves.toBe(true);
  });

  it('answers "not written" when a concurrent insert got there first', async () => {
    await expect(
      listCompanyFromMysoliq(failWith('23505'), '399999991', company),
    ).resolves.toBe(false);
  });

  it('still throws any other refusal, for the caller to count', async () => {
    await expect(
      listCompanyFromMysoliq(failWith('22001'), '399999991', company),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });
});
