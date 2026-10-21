jest.mock('axios');
import axios from 'axios';
import { ProxyPoolService } from './proxy-pool.service';

const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * The pool exists to be an optional advantage, never a dependency. Most of
 * what is pinned here is what it must NOT do: block a caller, throw when a
 * source is down, or hand out an address that stopped answering.
 */
describe('ProxyPoolService', () => {
  let service: ProxyPoolService;

  /**
   * `probeResults` maps a proxy endpoint to how the probe should go, so a
   * refill can be driven to any outcome. Anything not listed fails.
   */
  const arrange = (
    candidates: string[],
    probeResults: Record<string, boolean> = {},
  ) => {
    mockedAxios.get = jest
      .fn()
      .mockImplementation(async (url: string, cfg: any) => {
        if (String(url).includes('davreestr.uz')) {
          // The agent carries the endpoint, which is how the probe is routed.
          const endpoint = String(cfg?.httpsAgent?.endpoint ?? '');
          if (!probeResults[endpoint]) throw new Error('ECONNREFUSED');
          return { status: 200 };
        }
        // A source list. Both shapes are answered so either can be exercised.
        return {
          data: {
            proxies: candidates.map((c) => ({
              ip: c.split(':')[0],
              port: c.split(':')[1],
            })),
          },
        };
      });
    // agentFor is the only place the endpoint would otherwise be lost.
    jest
      .spyOn(service, 'agentFor')
      .mockImplementation((endpoint: string) => ({ endpoint }) as any);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProxyPoolService();
  });

  describe('acquire', () => {
    it('answers null rather than waiting when the pool is empty', () => {
      arrange([]);
      // Deliberately not awaited anywhere: a caller must never block on this.
      expect(service.acquire()).toBeNull();
    });

    it('starts a refill when it comes up empty', () => {
      arrange([]);
      const refill = jest.spyOn(service, 'refill').mockResolvedValue();
      service.acquire();
      expect(refill).toHaveBeenCalled();
    });

    // The ceiling davreestr enforces is per address. Handing every session
    // the same entry would pile all the traffic onto one IP and hit exactly
    // the limit the pool exists to raise.
    it('takes turns rather than favouring one address', async () => {
      arrange(['1.1.1.1:80', '2.2.2.2:80', '3.3.3.3:80'], {
        '1.1.1.1:80': true,
        '2.2.2.2:80': true,
        '3.3.3.3:80': true,
      });
      await service.refill();

      const taken = [
        service.acquire(),
        service.acquire(),
        service.acquire(),
        service.acquire(),
      ];

      expect(new Set(taken.slice(0, 3)).size).toBe(3); // all three used
      expect(taken[3]).toBe(taken[0]); // then round again
    });

    it('hands out the fastest address it has', async () => {
      arrange(['1.1.1.1:80', '2.2.2.2:80'], {
        '1.1.1.1:80': true,
        '2.2.2.2:80': true,
      });
      let call = 0;
      const realGet = mockedAxios.get;
      mockedAxios.get = jest
        .fn()
        .mockImplementation(async (url: string, cfg: any) => {
          if (String(url).includes('davreestr.uz')) {
            // Second candidate answers slower.
            if (call++ === 1) await new Promise((r) => setTimeout(r, 30));
          }
          return realGet(url, cfg);
        });

      await service.refill();

      // Fastest first in the pool, so a short pool favours the good ones as
      // the cursor goes round.
      expect(service.status().size).toBe(2);
      expect(service.acquire()).toBe(service.status().proxies[0].endpoint);
    });
  });

  describe('refill', () => {
    it('keeps only what reaches davreestr', async () => {
      arrange(['1.1.1.1:80', '2.2.2.2:80', '3.3.3.3:80'], {
        '2.2.2.2:80': true,
      });

      await service.refill();

      expect(service.status().proxies.map((p) => p.endpoint)).toEqual([
        '2.2.2.2:80',
      ]);
    });

    // Otherwise an admin asking for a refresh gets an instant answer that did
    // nothing, because a background refill happened to be in flight.
    it('makes a second caller wait for the refill already running', async () => {
      arrange(['1.1.1.1:80'], { '1.1.1.1:80': true });

      const [a, b] = [service.refill(), service.refill()];
      await Promise.all([a, b]);

      // One collection round, not two.
      const sourceCalls = mockedAxios.get.mock.calls.filter(
        (c) => !String(c[0]).includes('davreestr.uz'),
      );
      expect(sourceCalls).toHaveLength(2); // the two sources, once each
    });

    it('survives a source being down', async () => {
      mockedAxios.get = jest.fn().mockRejectedValue(new Error('503'));
      await expect(service.refill()).resolves.toBeUndefined();
      expect(service.status().size).toBe(0);
    });

    // A proxy that worked last time and fails the probe now has stopped
    // working; carrying it over would hand a dead address to the next session.
    it('replaces the pool rather than merging into it', async () => {
      arrange(['1.1.1.1:80'], { '1.1.1.1:80': true });
      await service.refill();
      expect(service.status().size).toBe(1);

      arrange(['9.9.9.9:80'], { '9.9.9.9:80': true });
      await service.refill();

      expect(service.status().proxies.map((p) => p.endpoint)).toEqual([
        '9.9.9.9:80',
      ]);
    });
  });

  describe('report', () => {
    beforeEach(async () => {
      arrange(['1.1.1.1:80'], { '1.1.1.1:80': true });
      await service.refill();
    });

    // davreestr returns errors of its own; blaming the proxy for the first
    // one would empty the pool in a morning.
    it('keeps a proxy through one and two failures', () => {
      service.report('1.1.1.1:80', false);
      service.report('1.1.1.1:80', false);
      expect(service.status().size).toBe(1);
    });

    it('drops it on the third in a row', () => {
      for (let i = 0; i < 3; i++) service.report('1.1.1.1:80', false);
      expect(service.status().size).toBe(0);
    });

    it('forgives once a session succeeds', () => {
      service.report('1.1.1.1:80', false);
      service.report('1.1.1.1:80', false);
      service.report('1.1.1.1:80', true);
      service.report('1.1.1.1:80', false);
      service.report('1.1.1.1:80', false);
      expect(service.status().size).toBe(1);
    });

    it('shrugs at an endpoint it has never heard of', () => {
      expect(() => service.report('9.9.9.9:80', false)).not.toThrow();
      expect(service.status().size).toBe(1);
    });
  });
});
