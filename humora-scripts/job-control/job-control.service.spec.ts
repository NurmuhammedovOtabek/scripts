import { BadRequestException } from '@nestjs/common';
import { JobControlService } from './job-control.service';

const holderRow = (pid: number, heldMinutes: number, state = 'idle') => ({
  pid,
  state,
  since: '2026-09-29T00:00:00Z',
  held_minutes: heldMinutes,
  application: null,
  client: '10.0.0.7',
  query: 'SELECT pg_try_advisory_lock($1) AS locked',
});

describe('JobControlService', () => {
  let db: { query: jest.Mock; createQueryRunner: jest.Mock };
  let runner: { connect: jest.Mock; release: jest.Mock; query: jest.Mock };
  let telegram: { send: jest.Mock; deliver: jest.Mock };
  let mahalla: { requestStop: jest.Mock };
  let service: JobControlService;
  /** What pg_locks answers for the lock asked about. */
  let held: ReturnType<typeof holderRow> | null;
  let ownPid: number;

  beforeEach(() => {
    held = null;
    ownPid = 1;
    const answer = async (sql: string) => {
      if (/FROM pg_locks/.test(sql)) return held ? [held] : [];
      if (/pg_backend_pid/.test(sql)) return [{ pid: ownPid }];
      if (/pg_terminate_backend/.test(sql)) return [{ ok: true }];
      if (/pg_advisory_unlock/.test(sql)) return [{ ok: true }];
      return [];
    };
    runner = {
      connect: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(answer),
    };
    db = {
      query: jest.fn(answer),
      createQueryRunner: jest.fn(() => runner),
    };
    telegram = {
      send: jest.fn().mockResolvedValue(true),
      deliver: jest.fn().mockResolvedValue(true),
    };
    mahalla = { requestStop: jest.fn().mockResolvedValue({ running: false }) };
    service = new JobControlService(db as any, telegram as any, mahalla as any);
  });

  const stopWrites = () =>
    db.query.mock.calls
      .filter(([sql]) => /INSERT INTO public\.job_controls/.test(String(sql)))
      .map(([, p]) => p[0]);
  const audit = () =>
    db.query.mock.calls.filter(([sql]) =>
      /INSERT INTO public\.job_runs/.test(String(sql)),
    );

  describe('stop', () => {
    it('stops the Sunday chain and whichever step it is on', async () => {
      held = holderRow(77, 12);
      const r = await service.stop('weekly');
      expect(stopWrites()).toEqual(['weekly', 'ns_soato_map', 'registries']);
      expect(mahalla.requestStop).toHaveBeenCalled();
      expect(r).toMatchObject({ stop_requested: true, running: true });
      expect(telegram.deliver.mock.calls[0][0]).toMatch(
        /Stop requested by hand — Sunday 04:30 chain[\s\S]*pid 77, 12 min/,
      );
      expect(audit()).toHaveLength(1);
    });

    it('stops the mahalla run through its own flag, the map through job_controls', async () => {
      await service.stop('company_mahalla');
      expect(mahalla.requestStop).toHaveBeenCalledTimes(1);
      expect(stopWrites()).toEqual([]);
      await service.stop('ns_soato_map');
      expect(stopWrites()).toEqual(['ns_soato_map']);
      expect(telegram.deliver.mock.calls[1][0]).toMatch(/Nothing was running/);
    });

    it('has no stop for the bank sync, and knows no other job', async () => {
      await expect(service.stop('bank_registry')).rejects.toThrow(
        /takes seconds[\s\S]*unlock/,
      );
      await expect(service.stop('everything')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('unlock', () => {
    const terminated = () =>
      runner.query.mock.calls.filter(([sql]) =>
        /pg_terminate_backend/.test(String(sql)),
      );

    it('says so when nothing holds the lock', async () => {
      await expect(service.unlock('ns_soato_map', false)).resolves.toEqual({
        job: 'ns_soato_map',
        released: false,
        reason: 'the lock is not held',
      });
      expect(terminated()).toHaveLength(0);
      expect(runner.release).toHaveBeenCalled();
    });

    it('refuses a lock younger than a normal run, unless forced', async () => {
      held = holderRow(501, 10);
      const r = await service.unlock('company_mahalla', false);
      expect(r).toMatchObject({ released: false });
      expect(r.reason).toMatch(/held for 10 min by pid 501[\s\S]*force=1/);
      expect(terminated()).toHaveLength(0);
      expect(telegram.deliver).not.toHaveBeenCalled();

      const forced = await service.unlock('company_mahalla', true);
      expect(forced).toMatchObject({ released: true });
      expect(terminated()[0][1]).toEqual([501]);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(
        /Lock released by hand[\s\S]*pid 501[\s\S]*force/,
      );
      expect(audit()).toHaveLength(1);
    });

    it('ends the session of a lock held past its job’s normal time', async () => {
      held = holderRow(9, 245);
      await expect(service.unlock('weekly', false)).resolves.toMatchObject({
        released: true,
      });
      expect(terminated()[0][1]).toEqual([9]);
    });

    it('releases a lock the pool handed back to it, instead of ending itself', async () => {
      held = holderRow(33, 400);
      ownPid = 33;
      await expect(
        service.unlock('bank_registry', false),
      ).resolves.toMatchObject({ released: true });
      expect(terminated()).toHaveLength(0);
      expect(
        runner.query.mock.calls.some(([sql]) =>
          /pg_advisory_unlock/.test(String(sql)),
        ),
      ).toBe(true);
    });
  });

  it('shows every job with its lock holder and whether it looks stuck', async () => {
    held = holderRow(5, 200);
    const s = (await service.status()) as { jobs: any[] };
    expect(s.jobs.map((j) => j.job)).toEqual([
      'weekly',
      'company_mahalla',
      'ns_soato_map',
      'bank_registry',
      'oked_tree',
      'company_accreditations',
      'postcode_watch',
      'registries',
    ]);
    const weekly = s.jobs[0];
    expect(weekly).toMatchObject({
      running: true,
      looks_stuck: true,
      stuck_after_minutes: 180,
    });
    expect(s.jobs[3]).toMatchObject({ stoppable: false });
    expect(s.jobs[4]).toMatchObject({ stoppable: false });
    expect(s.jobs[5]).toMatchObject({
      stoppable: false,
      stuck_after_minutes: 150,
    });
  });
});
