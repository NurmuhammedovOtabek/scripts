import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { LicenseQueueService } from './license-queue.service';
import {
  LICENSE_QUEUE,
  PARTNER_JOB_PRIORITY,
  licencesAreStale,
  licenseAttemptKey,
  licenseJobId,
} from './license-queue.constants';

/**
 * A Redis small enough to reason about, honest about the one behaviour the
 * service depends on: `SET … NX` refuses when the key is already there.
 */
const fakeRedis = (seed: Record<string, string> = {}) => {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(
      async (
        k: string,
        v: string,
        _mode?: string,
        _sec?: number,
        nx?: string,
      ) => {
        if (nx === 'NX' && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      },
    ),
  };
};

describe('licenseJobId', () => {
  it('contains no colon', () => {
    // BullMQ rejects a colon in a custom job id — it reserves colons for its
    // own Redis keys. This threw on every enqueue until the separator changed,
    // and the error surfaced only as a warn log, so nothing failed loudly.
    expect(licenseJobId('302114274')).not.toContain(':');
  });

  it('is stable for the same company, distinct across companies', () => {
    expect(licenseJobId('302114274')).toBe(licenseJobId('302114274'));
    expect(licenseJobId('302114274')).not.toBe(licenseJobId('311806374'));
  });
});

describe('LicenseQueueService', () => {
  /**
   * `held` is what Redis already has for this company: a timestamp means the
   * daily attempt is spent, null means the slot is free.
   */
  const build = async (
    add: jest.Mock,
    getJob?: jest.Mock,
    held: string | null = null,
  ) => {
    const redis = fakeRedis(
      held ? { [licenseAttemptKey('302114274')]: held } : {},
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        LicenseQueueService,
        {
          provide: getQueueToken(LICENSE_QUEUE),
          useValue: {
            add,
            getJob: getJob ?? jest.fn().mockResolvedValue(undefined),
            getJobCounts: jest
              .fn()
              .mockResolvedValue({ waiting: 0, active: 0, failed: 0 }),
            backend: { client: Promise.resolve(redis) },
          },
        },
      ],
    }).compile();
    return moduleRef.get(LicenseQueueService);
  };

  it('queues one job per company, keyed so duplicates collapse', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'licenses-302114274' });
    const svc = await build(add);

    await svc.enqueue('302114274');

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0];
    expect(name).toBe('fetch');
    expect(data).toEqual({ inn: '302114274' });
    // Keyed to this attempt, not to the company: a completed record left
    // behind by yesterday's fetch must not refuse today's.
    expect(opts.jobId).toMatch(/^licenses-302114274-\d+$/);
    expect(opts.attempts).toBe(2);
  });

  it('costs one fetch when several people open the same company', async () => {
    // The claim is what collapses these now, not the job id: only the caller
    // that wins `SET NX` goes on to enqueue. The id could not do it any more
    // — it carries the claim, so two claims would produce two different ids.
    const add = jest.fn().mockResolvedValue({ id: 'x', timestamp: Date.now() });
    const svc = await build(add, undefined, null);

    await Promise.all([
      svc.enqueue('302114274'),
      svc.enqueue('302114274'),
      svc.enqueue('302114274'),
    ]);

    expect(add).toHaveBeenCalledTimes(1);
  });

  /**
   * The box runs one fetch at a time. A partner checking a thousand companies
   * must not put hours of work ahead of the next person opening a company
   * page — and BullMQ runs jobs without a priority before any with one.
   */
  it("puts a partner's fetch behind the site's", async () => {
    const add = jest.fn().mockResolvedValue({ id: 'x' });

    await (await build(add)).enqueue('302114274', 'partner');
    await (await build(add)).enqueue('311806374');

    expect(add.mock.calls[0][2].priority).toBe(PARTNER_JOB_PRIORITY);
    expect(add.mock.calls[1][2]).not.toHaveProperty('priority');
  });

  describe('a company page asking for a company a partner already queued', () => {
    const STAMP = new Date(Date.now() - 60_000).toISOString();
    const jobIn = (state: string) => ({
      getState: jest.fn().mockResolvedValue(state),
      changePriority: jest.fn().mockResolvedValue(undefined),
    });

    it("moves the partner's waiting fetch into the site's line", async () => {
      const add = jest.fn();
      const job = jobIn('prioritized');
      const getJob = jest.fn().mockResolvedValue(job);

      await (await build(add, getJob, STAMP)).enqueue('302114274');

      expect(getJob).toHaveBeenCalledWith(licenseJobId('302114274', STAMP));
      expect(job.changePriority).toHaveBeenCalledWith({ priority: 0 });
      expect(add).not.toHaveBeenCalled();
    });

    it.each(['waiting', 'active', 'completed', 'failed'])(
      'leaves a job that is %s where it is',
      async (state) => {
        const job = jobIn(state);
        const getJob = jest.fn().mockResolvedValue(job);

        await (await build(jest.fn(), getJob, STAMP)).enqueue('302114274');

        expect(job.changePriority).not.toHaveBeenCalled();
      },
    );

    it('moves nothing when another partner request asks', async () => {
      const job = jobIn('prioritized');
      const getJob = jest.fn().mockResolvedValue(job);

      await (
        await build(jest.fn(), getJob, STAMP)
      ).enqueue('302114274', 'partner');

      expect(job.changePriority).not.toHaveBeenCalled();
    });
  });

  it('does not throw when Redis is unreachable', async () => {
    // The page that triggered this has already been served. A queue that is
    // down must leave the company unfilled, not break the response.
    const add = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = await build(add);

    await expect(svc.enqueue('302114274')).resolves.toBeUndefined();
  });

  it('reports empty stats rather than throwing when Redis is unreachable', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LicenseQueueService,
        {
          provide: getQueueToken(LICENSE_QUEUE),
          useValue: {
            add: jest.fn(),
            getJobCounts: jest
              .fn()
              .mockRejectedValue(new Error('ECONNREFUSED')),
          },
        },
      ],
    }).compile();

    await expect(moduleRef.get(LicenseQueueService).stats()).resolves.toEqual(
      {},
    );
  });
});

describe('LicenseQueueService.fetchState', () => {
  const STAMP = '2026-08-25T12:00:00.000Z';

  /** `marked` false means nothing has been asked inside the window. */
  const build = async (getJob: jest.Mock, marked = true) => {
    const redis = fakeRedis(
      marked ? { [licenseAttemptKey('302114274')]: STAMP } : {},
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        LicenseQueueService,
        {
          provide: getQueueToken(LICENSE_QUEUE),
          useValue: {
            add: jest.fn(),
            getJob,
            getJobCounts: jest.fn(),
            backend: { client: Promise.resolve(redis) },
          },
        },
      ],
    }).compile();
    return moduleRef.get(LicenseQueueService);
  };

  const jobIn = (state: string) => ({
    id: 'licenses-302114274',
    getState: jest.fn().mockResolvedValue(state),
  });

  it('calls a queued fetch pending, so the page does not claim "no permits"', async () => {
    // An empty licence table means either "nobody has asked yet" or "the
    // registry holds none". Flattening the two is how a page ends up stating
    // something about the company that is really a statement about us.
    for (const state of ['waiting', 'active', 'delayed']) {
      const svc = await build(jest.fn().mockResolvedValue(jobIn(state)));
      await expect(svc.fetchState('302114274')).resolves.toBe('pending');
    }
  });

  it('calls a finished fetch done, so an empty table can be believed', async () => {
    const svc = await build(jest.fn().mockResolvedValue(jobIn('completed')));
    await expect(svc.fetchState('302114274')).resolves.toBe('done');
  });

  it('reports a failed job as failed rather than as an empty answer', async () => {
    const svc = await build(jest.fn().mockResolvedValue(jobIn('failed')));
    await expect(svc.fetchState('302114274')).resolves.toBe('failed');
  });

  it('treats no job at all as done — nothing is coming', async () => {
    const svc = await build(jest.fn().mockResolvedValue(undefined));
    await expect(svc.fetchState('302114274')).resolves.toBe('done');
  });

  it('reports failed when Redis cannot be read', async () => {
    // Not 'done', which would assert the company holds nothing, and not
    // 'pending', which would leave the page waiting on something that cannot
    // arrive. 'failed' is the one the page can offer a retry for.
    const svc = await build(
      jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(svc.fetchState('302114274')).resolves.toBe('failed');
  });
});

describe('LicenseQueueService — one attempt per company per day', () => {
  const build = async (
    add: jest.Mock,
    held: string | null,
    inn = '302114274',
  ) => {
    const redis = fakeRedis(held ? { [licenseAttemptKey(inn)]: held } : {});
    const moduleRef = await Test.createTestingModule({
      providers: [
        LicenseQueueService,
        {
          provide: getQueueToken(LICENSE_QUEUE),
          useValue: {
            add,
            getJob: jest.fn().mockResolvedValue(undefined),
            getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
            backend: { client: Promise.resolve(redis) },
          },
        },
      ],
    }).compile();
    return { svc: moduleRef.get(LicenseQueueService), set: redis.set };
  };

  it('does not ask again about a company asked earlier today', async () => {
    // The registry publishes no rate limit and refuses without saying why, so
    // how often we knock is the only lever we hold.
    const add = jest.fn();
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { svc } = await build(add, anHourAgo);

    await svc.enqueue('302114274');

    expect(add).not.toHaveBeenCalled();
  });

  it('holds the company back whatever last time came to', async () => {
    // Success, empty and failure were three different windows before this —
    // 24 hours, 24 hours and seven days — purely as a side effect of how long
    // BullMQ happened to keep each kind of record.
    for (const outcome of ['done', 'failed', 'empty']) {
      const inn = `3021142${outcome.length}4`;
      const add = jest.fn();
      const { svc } = await build(add, new Date().toISOString(), inn);
      await svc.enqueue(inn);
      expect(add).not.toHaveBeenCalled();
    }
  });

  it('claims the slot with a day-long expiry when it is free', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'x', timestamp: Date.now() });
    const { svc, set } = await build(add, null);

    await svc.enqueue('302114274');

    expect(add).toHaveBeenCalledTimes(1);
    // SET <key> <stamp> EX 86400 NX — the NX is what makes the claim a race
    // Redis settles rather than one the instances settle between themselves.
    const [key, , mode, seconds, nx] = set.mock.calls[0];
    expect(key).toBe('licenses:attempted:302114274');
    expect(mode).toBe('EX');
    expect(seconds).toBe(24 * 3600);
    expect(nx).toBe('NX');
  });

  it('records the moment it asked, not the moment the answer came', async () => {
    // The window runs from the request, so a two-minute walk does not buy
    // itself two extra minutes of quiet.
    const add = jest.fn().mockResolvedValue({ id: 'x', timestamp: Date.now() });
    const before = Date.now();
    const { svc, set } = await build(add, null);

    await svc.enqueue('302114274');

    const stamped = Date.parse(set.mock.calls[0][1] as string);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });
});

describe('licencesAreStale', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-08-25T12:00:00Z');

  it('leaves recently fetched permits alone', () => {
    expect(licencesAreStale(new Date(now - 2 * day), now, 7)).toBe(false);
  });

  it('refreshes once past the window', () => {
    // INN 202099756 was the case: ten rows stored before pagination worked,
    // never looked at again, while the registry held forty-six.
    expect(licencesAreStale(new Date(now - 30 * day), now, 7)).toBe(true);
  });

  it('treats the boundary as stale', () => {
    expect(licencesAreStale(new Date(now - 7 * day), now, 7)).toBe(true);
  });

  it('does not refresh when there is no timestamp to judge by', () => {
    // Rows predating the column would otherwise read as infinitely old, and
    // every company would refetch on its next view.
    expect(licencesAreStale(null, now, 7)).toBe(false);
    expect(licencesAreStale(new Date('nonsense'), now, 7)).toBe(false);
  });
});

describe('licenseAttemptKey on the shared Redis', () => {
  const before = process.env.REDIS_KEY_PREFIX;
  afterEach(() => {
    if (before === undefined) delete process.env.REDIS_KEY_PREFIX;
    else process.env.REDIS_KEY_PREFIX = before;
  });

  it('carries REDIS_KEY_PREFIX, since BullMQ connections take no keyPrefix', () => {
    process.env.REDIS_KEY_PREFIX = 'humora-backend';
    expect(licenseAttemptKey('302114274')).toBe(
      'humora-backend:licenses:attempted:302114274',
    );
  });
});
