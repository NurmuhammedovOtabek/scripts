jest.mock('axios');

import axios from 'axios';
import { CbuApiService, isCbuCircuitOpenError } from './cbu-api.service';

const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Regression guard for the 2026-08-04 CBU outage.
 *
 * faktoring.cbu.uz accepted TCP connections on `/integration/api/*` and then
 * never wrote a single response byte for 7+ hours, while `GET /` (200 in 3ms)
 * and `POST /integration/auth/login` (401 in 19ms) stayed healthy throughout.
 *
 * This service was by far the largest contributor to the resulting storm:
 * 4,671 of the day's 4,805 aborted requests were its `company/info` calls at
 * 20s each — about 93,000 socket-seconds, versus 7,560 for the FLOTT
 * integration-service. Nothing stopped it retrying for the whole outage.
 *
 * Because auth stayed up the entire time, auth must never be what decides the
 * upstream is healthy again — the probe has to exercise the data plane.
 */
describe('CbuApiService — CBU circuit breaker', () => {
  let auth: { getToken: jest.Mock; invalidate: jest.Mock };
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    auth = {
      getToken: jest.fn().mockResolvedValue('tok'),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    // The service reads `axios.isAxiosError`; the automock stubs it out.
    (mockedAxios as unknown as { isAxiosError: unknown }).isAxiosError = (
      e: unknown,
    ) => !!(e as { isAxiosError?: boolean })?.isAxiosError;
    process.env.FACTORING_BASE_URL = 'http://faktoring.cbu.uz';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  function makeService(env: Record<string, string> = {}): CbuApiService {
    Object.assign(process.env, env);
    return new CbuApiService(auth as never);
  }

  /** No HTTP response at all — the outage signature. */
  const hang = () =>
    Object.assign(new Error('timeout of 20000ms exceeded'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    });

  /** An error carrying a real response, i.e. proof the upstream is alive. */
  const withStatus = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data: {} },
    });

  const OK = { data: { success: true, data: {}, error: null } };

  const drive = async (service: CbuApiService, n: number) => {
    for (let i = 0; i < n; i++) {
      await service.getCompanyInfo('309455487').catch(() => undefined);
    }
  };

  // ============ X-Trace-Id ============

  describe('X-Trace-Id', () => {
    it('sends X-Trace-Id and X-Correlation-ID on company/info', async () => {
      mockedAxios.get.mockResolvedValue(OK);
      const service = makeService();

      await service.getCompanyInfo('309455487');

      const [, cfg] = mockedAxios.get.mock.calls[0];
      const headers = (cfg as { headers: Record<string, string> }).headers;
      expect(headers['X-Trace-Id']).toEqual(expect.any(String));
      expect(headers['X-Trace-Id']).toHaveLength(36); // uuid v4
      // CBU support searches their logs by this; both names carry one value.
      expect(headers['X-Correlation-ID']).toBe(headers['X-Trace-Id']);
    });

    it('uses a fresh trace id per request, so one id maps to one CBU log line', async () => {
      mockedAxios.get.mockResolvedValue(OK);
      const service = makeService();

      await service.getCompanyInfo('1');
      await service.getCompanyInfo('2');

      const ids = mockedAxios.get.mock.calls.map(
        ([, cfg]) =>
          (cfg as { headers: Record<string, string> }).headers['X-Trace-Id'],
      );
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  // ============ Opening ============

  describe('opening', () => {
    it('opens after 3 consecutive hangs', async () => {
      mockedAxios.get.mockRejectedValue(hang());
      const service = makeService();

      await drive(service, 3);

      expect(service.circuitOpen).toBe(true);
    });

    it('short-circuits WITHOUT a socket once open — and without asking for a token', async () => {
      mockedAxios.get.mockRejectedValue(hang());
      const service = makeService();
      await drive(service, 3);

      const httpBefore = mockedAxios.get.mock.calls.length;
      const authBefore = auth.getToken.mock.calls.length;

      await expect(service.getCompanyInfo('1')).rejects.toMatchObject({
        code: 'CBU_CIRCUIT_OPEN',
      });

      // Zero new work. getToken() is cache-backed but falls through to a 15s
      // login on a cold cache — during an outage that is another hung socket.
      expect(mockedAxios.get).toHaveBeenCalledTimes(httpBefore);
      expect(auth.getToken).toHaveBeenCalledTimes(authBefore);
    });

    it('exposes a recognisable error so retry loops can stop early', async () => {
      mockedAxios.get.mockRejectedValue(hang());
      const service = makeService();
      await drive(service, 3);

      const err = await service.getCompanyInfo('1').catch((e) => e);
      expect(isCbuCircuitOpenError(err)).toBe(true);
    });

    it.each([500, 502, 503, 429])('opens on %i', async (status) => {
      mockedAxios.get.mockRejectedValue(withStatus(status));
      const service = makeService();

      await drive(service, 3);

      expect(service.circuitOpen).toBe(true);
    });

    it('opens when the token fetch itself hangs', async () => {
      auth.getToken.mockRejectedValue(hang());
      const service = makeService();

      await drive(service, 3);

      expect(service.circuitOpen).toBe(true);
    });
  });

  // ============ NOT opening ============

  describe('business answers never open it', () => {
    it.each([400, 401, 403, 404, 409, 422])(
      'a run of %i responses leaves the circuit closed',
      async (status) => {
        mockedAxios.get.mockRejectedValue(withStatus(status));
        const service = makeService();

        await drive(service, 10);

        // A 4xx proves CBU answered. Tripping on 401 in particular would turn
        // a credentials problem into a fake outage across every caller.
        expect(service.circuitOpen).toBe(false);
      },
    );

    it('still invalidates the cached token on 401', async () => {
      mockedAxios.get.mockRejectedValue(withStatus(401));
      const service = makeService();

      await service.getCompanyInfo('1').catch(() => undefined);

      expect(auth.invalidate).toHaveBeenCalledTimes(1);
    });

    it('a success in between resets the failure run', async () => {
      const service = makeService();
      mockedAxios.get.mockRejectedValue(hang());
      await drive(service, 2);
      mockedAxios.get.mockResolvedValue(OK);
      await service.getCompanyInfo('1');
      mockedAxios.get.mockRejectedValue(hang());
      await drive(service, 2);

      // 2 + 2 consecutive failures either side of a success never reaches 3.
      expect(service.circuitOpen).toBe(false);
    });
  });

  // ============ Recovery ============

  describe('recovery', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('lets exactly ONE probe through after the cooldown, not the whole backlog', async () => {
      mockedAxios.get.mockRejectedValue(hang());
      const service = makeService({ CBU_BREAKER_COOLDOWN_MS: '60' });
      await drive(service, 3);
      await sleep(100);

      const before = mockedAxios.get.mock.calls.length;
      // Five callers arrive at once the moment the cooldown expires.
      await Promise.all(
        Array.from({ length: 5 }, () =>
          service.getCompanyInfo('1').catch(() => undefined),
        ),
      );

      // Only the probe reaches the network; the rest bounce off the re-armed
      // cooldown. Without that re-arm, a dead upstream gets the full burst.
      expect(mockedAxios.get.mock.calls.length).toBe(before + 1);
    });

    it('closes when the probe succeeds', async () => {
      mockedAxios.get.mockRejectedValue(hang());
      const service = makeService({ CBU_BREAKER_COOLDOWN_MS: '60' });
      await drive(service, 3);
      expect(service.circuitOpen).toBe(true);

      mockedAxios.get.mockResolvedValue(OK);
      await sleep(100);
      await service.getCompanyInfo('1');

      expect(service.circuitOpen).toBe(false);
    });

    it('re-arms the cooldown when the probe fails', async () => {
      mockedAxios.get.mockRejectedValue(hang());
      const service = makeService({ CBU_BREAKER_COOLDOWN_MS: '60' });
      await drive(service, 3);
      await sleep(100);

      await service.getCompanyInfo('1').catch(() => undefined); // the probe
      const after = mockedAxios.get.mock.calls.length;

      await expect(service.getCompanyInfo('1')).rejects.toMatchObject({
        code: 'CBU_CIRCUIT_OPEN',
      });
      expect(mockedAxios.get.mock.calls.length).toBe(after);
    });
  });

  // ============ Kill switch ============

  it('can be disabled via CBU_BREAKER_ENABLED=false', async () => {
    mockedAxios.get.mockRejectedValue(hang());
    const service = makeService({ CBU_BREAKER_ENABLED: 'false' });

    await drive(service, 6);

    expect(service.circuitOpen).toBe(false);
    const before = mockedAxios.get.mock.calls.length;
    await service.getCompanyInfo('1').catch(() => undefined);
    expect(mockedAxios.get.mock.calls.length).toBe(before + 1);
  });
});
