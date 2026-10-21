import {
  advisoryLockHolder,
  jobStopRequested,
  requestJobStop,
} from './job-control';

describe('job control helpers', () => {
  it('records a stop request per job', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    await requestJobStop(db, 'ns_soato_map');
    expect(db.query.mock.calls[0][0]).toMatch(
      /INSERT INTO public\.job_controls[\s\S]*ON CONFLICT \(job\) DO UPDATE SET stop_requested_at = now\(\)/,
    );
    expect(db.query.mock.calls[0][1]).toEqual(['ns_soato_map']);
  });

  it('obeys only a request newer than the run, and never stops on a failed read', async () => {
    const since = new Date('2026-09-29T04:30:00Z');
    const db = { query: jest.fn() };
    db.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(jobStopRequested(db, 'weekly', since)).resolves.toBe(true);
    expect(db.query.mock.calls[0][0]).toMatch(/stop_requested_at >= \$2/);
    expect(db.query.mock.calls[0][1]).toEqual(['weekly', since]);
    db.query.mockResolvedValueOnce([]);
    await expect(jobStopRequested(db, 'weekly', since)).resolves.toBe(false);
    db.query.mockRejectedValueOnce(new Error('relation does not exist'));
    await expect(jobStopRequested(db, 'weekly', since)).resolves.toBe(false);
  });

  it('finds who holds an advisory lock', async () => {
    const db = {
      query: jest.fn().mockResolvedValueOnce([
        {
          pid: '4242',
          state: 'idle',
          since: '2026-09-29T00:30:00Z',
          held_minutes: 245,
          application: null,
          client: '10.0.0.7',
          query: 'SELECT pg_try_advisory_lock($1) AS locked',
        },
      ]),
    };
    await expect(advisoryLockHolder(db, 8_150_936)).resolves.toMatchObject({
      pid: 4242,
      state: 'idle',
      held_minutes: 245,
      client: '10.0.0.7',
    });
    // Keys under 2^32 sit in objid with classid 0; one-key locks are objsubid 1.
    expect(db.query.mock.calls[0][0]).toMatch(
      /classid = 0 AND l\.objid = \$1 AND l\.objsubid = 1/,
    );
    db.query.mockResolvedValueOnce([]);
    await expect(advisoryLockHolder(db, 1)).resolves.toBeNull();
  });
});
