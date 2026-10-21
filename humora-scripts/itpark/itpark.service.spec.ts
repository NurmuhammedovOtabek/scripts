import { ItparkScriptService } from './itpark.service';

/**
 * The whole point of these tests is the difference between "not a resident"
 * and "we could not tell". The caller writes this value straight into
 * company_info.itpark, so answering false when the list is not known silently
 * strips the IT Park mark off a resident and writes the flip into their
 * history. The answer comes from our daily copy of the residents list.
 */
describe('ItparkScriptService.checkResident', () => {
  const RESIDENT = '301234567';

  let db: { query: jest.Mock };
  let service: ItparkScriptService;

  beforeEach(() => {
    db = { query: jest.fn() };
    service = new ItparkScriptService(db as any);
  });

  it('answers true, and since when, for a company the list holds', async () => {
    db.query.mockResolvedValue([{ listed: true, since: '2024-03-12' }]);
    await expect(service.residency(RESIDENT)).resolves.toEqual({
      resident: true,
      since: '2024-03-12',
    });
    await expect(service.checkResident(RESIDENT)).resolves.toBe(true);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/last_ok_at > now\(\) - make_interval/);
    expect(params).toEqual([RESIDENT, 'itpark_resident', 3]);
  });

  it('answers false when a fresh list does not hold the company', async () => {
    db.query.mockResolvedValue([{ listed: false, since: null }]);
    await expect(service.checkResident(RESIDENT)).resolves.toBe(false);
  });

  // The list never read, or not read for days: an old copy is not an answer.
  it('answers null when the list is not fresh', async () => {
    db.query.mockResolvedValue([]);
    await expect(service.residency(RESIDENT)).resolves.toEqual({
      resident: null,
      since: null,
    });
  });

  it('answers null when the list cannot be read', async () => {
    db.query.mockRejectedValue(new Error('connection reset'));
    await expect(service.checkResident(RESIDENT)).resolves.toBeNull();
  });

  it('asks no website: a company page reads our copy only', async () => {
    db.query.mockResolvedValue([{ listed: true, since: null }]);
    await service.checkResident(RESIDENT);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).not.toMatch(/UPDATE|INSERT/);
  });
});
