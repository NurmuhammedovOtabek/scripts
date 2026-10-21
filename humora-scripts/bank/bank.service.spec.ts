import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import axios from 'axios';
import { BankScriptService } from './bank.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeResponse = (tableColumn: any) => ({
  data: { result: { data: [{ tableColumn }] } },
});

describe('BankScriptService', () => {
  let service: BankScriptService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankScriptService,
        {
          // A cache that never hits, so every test below still exercises the
          // parsing path it was written for.
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn().mockResolvedValue(undefined),
            set: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = module.get(BankScriptService);
  });

  // ─── getByMfo: empty / missing data ──────────────────────────────────────

  describe('getByMfo (no data)', () => {
    it('returns null when result data array is empty', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { result: { data: [] } },
      });
      expect(await service.getByMfo('00987')).toBeNull();
    });

    it('returns null when result is missing entirely', async () => {
      mockedAxios.post.mockResolvedValue({ data: {} });
      expect(await service.getByMfo('00987')).toBeNull();
    });
  });

  // ─── getByMfo: missing BANK_NAME ─────────────────────────────────────────

  describe('getByMfo (missing BANK_NAME)', () => {
    it('returns null when tableColumn has no BANK_NAME', async () => {
      mockedAxios.post.mockResolvedValue(makeResponse({}));
      expect(await service.getByMfo('00987')).toBeNull();
    });

    it('returns null when BANK_NAME.data is empty string', async () => {
      mockedAxios.post.mockResolvedValue(
        makeResponse({ BANK_NAME: { data: '   ' } }),
      );
      expect(await service.getByMfo('00987')).toBeNull();
    });

    it('returns null when BANK_NAME.data is null', async () => {
      mockedAxios.post.mockResolvedValue(
        makeResponse({ BANK_NAME: { data: null } }),
      );
      expect(await service.getByMfo('00987')).toBeNull();
    });
  });

  // ─── getByMfo: success ────────────────────────────────────────────────────

  describe('getByMfo (success)', () => {
    it('returns bank_name and bank_code on valid response', async () => {
      mockedAxios.post.mockResolvedValue(
        makeResponse({ BANK_NAME: { data: '  Asaka Bank  ' } }),
      );
      const result = await service.getByMfo('00873');
      expect(result).toEqual({ bank_name: 'Asaka Bank', bank_code: '00873' });
    });

    it('trims whitespace from bank_name', async () => {
      mockedAxios.post.mockResolvedValue(
        makeResponse({ BANK_NAME: { data: '  NBU  ' } }),
      );
      const result = await service.getByMfo('00001');
      expect(result!.bank_name).toBe('NBU');
    });

    it('sets bank_code to the mfo argument', async () => {
      mockedAxios.post.mockResolvedValue(
        makeResponse({ BANK_NAME: { data: 'Ipoteka Bank' } }),
      );
      const result = await service.getByMfo('00555');
      expect(result!.bank_code).toBe('00555');
    });
  });

  // ─── getByMfo: network error ──────────────────────────────────────────────

  describe('getByMfo (network error)', () => {
    it('returns null when axios throws', async () => {
      mockedAxios.post.mockRejectedValue(new Error('ETIMEDOUT'));
      expect(await service.getByMfo('00987')).toBeNull();
    });
  });
});

const row = (name: string) => ({
  data: { result: { data: [{ tableColumn: { BANK_NAME: { data: name } } }] } },
});

/**
 * A company that changes bank used to keep the old bank's name against the new
 * bank's code, because the name was only ever resolved when it was missing.
 * 4,318 rows carried a name that did not belong to their MFO; the one that got
 * reported showed Trastbank's code (00491) under NBU's name.
 *
 * The callers now resolve on every sync, which is only affordable because of
 * the cache here — so the cache is the part worth holding to its promises.
 */
describe('BankScriptService', () => {
  let service: BankScriptService;
  let store: Map<string, unknown>;

  beforeEach(async () => {
    jest.clearAllMocks();
    store = new Map();
    const cache = {
      get: jest.fn(async (k: string) =>
        store.has(k) ? store.get(k) : undefined,
      ),
      set: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankScriptService,
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();
    service = module.get(BankScriptService);
  });

  it('asks the registry once, then answers from the cache', async () => {
    mockedAxios.post.mockResolvedValue(row('ТРАСТБАНК'));

    for (let i = 0; i < 10; i++) {
      const out = await service.getByMfo('00491');
      expect(out).toEqual({ bank_name: 'ТРАСТБАНК', bank_code: '00491' });
    }
    // Ten syncs, one call. This is what lets the callers stop guarding the
    // lookup behind "only if we have no name".
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('keeps different codes apart', async () => {
    mockedAxios.post
      .mockResolvedValueOnce(row('ТРАСТБАНК'))
      .mockResolvedValueOnce(row('ТИФ МИЛЛИЙ БАНКИ'));

    expect((await service.getByMfo('00491'))?.bank_name).toBe('ТРАСТБАНК');
    expect((await service.getByMfo('00450'))?.bank_name).toBe(
      'ТИФ МИЛЛИЙ БАНКИ',
    );
    // Cached per code — the second must not be served the first's answer,
    // which is the exact shape of the bug this replaces.
    expect((await service.getByMfo('00491'))?.bank_name).toBe('ТРАСТБАНК');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it('remembers an unknown code, so it is not looked up for ever', async () => {
    mockedAxios.post.mockResolvedValue({ data: { result: { data: [] } } });

    expect(await service.getByMfo('99999')).toBeNull();
    expect(await service.getByMfo('99999')).toBeNull();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so an outage does not last a week', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await service.getByMfo('00491')).toBeNull();

    mockedAxios.post.mockResolvedValueOnce(row('ТРАСТБАНК'));
    expect((await service.getByMfo('00491'))?.bank_name).toBe('ТРАСТБАНК');
  });

  it('survives a cache that is not working', async () => {
    const cache = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      set: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const module = await Test.createTestingModule({
      providers: [
        BankScriptService,
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();
    const s = module.get(BankScriptService);
    mockedAxios.post.mockResolvedValue(row('ТРАСТБАНК'));

    expect((await s.getByMfo('00491'))?.bank_name).toBe('ТРАСТБАНК');
  });
});
