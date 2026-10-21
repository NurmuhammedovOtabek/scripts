import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { getDataSourceToken } from '@nestjs/typeorm';
import { of } from 'rxjs';
import { BadSuppliersService } from './bad-suppliers.service';

const mockHttp = () => ({ post: jest.fn() });
const mockDb = () => ({ query: jest.fn() });

const makeRpcResponse = (result: any) => of({ data: { result } } as any);

describe('BadSuppliersService', () => {
  let service: BadSuppliersService;
  let http: ReturnType<typeof mockHttp>;
  let db: ReturnType<typeof mockDb>;

  beforeEach(async () => {
    http = mockHttp();
    db = mockDb();
    db.query.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BadSuppliersService,
        { provide: HttpService, useValue: http },
        { provide: getDataSourceToken('flottDb'), useValue: db },
      ],
    }).compile();

    service = module.get(BadSuppliersService);
  });

  // ─── toDateString ─────────────────────────────────────────────────────────

  describe('toDateString', () => {
    const fn = (v: any) => (service as any).toDateString(v);

    it('returns null for null', () => expect(fn(null)).toBeNull());
    it('returns null for undefined', () => expect(fn(undefined)).toBeNull());
    it('returns null for empty string', () => expect(fn('')).toBeNull());

    it('returns date from ISO timestamp', () => {
      expect(fn('2025-09-23T00:00:00.000000Z')).toBe('2025-09-23');
    });

    it('returns already-formatted YYYY-MM-DD unchanged', () => {
      expect(fn('2025-09-23')).toBe('2025-09-23');
    });

    it('returns null for completely invalid string', () => {
      expect(fn('not-a-date')).toBeNull();
    });
  });

  // ─── mapRecord ────────────────────────────────────────────────────────────

  describe('mapRecord', () => {
    const fn = (r: any) => (service as any).mapRecord(r);

    it('maps code to inn as string', () => {
      expect(fn({ code: 123 }).inn).toBe('123');
    });

    it('falls back to id when code is missing', () => {
      expect(fn({ id: 456 }).inn).toBe('456');
    });

    it('maps name and note fields', () => {
      const r = fn({ code: '1', name: 'Test LLC', note: 'some note' });
      expect(r.name).toBe('Test LLC');
      expect(r.note).toBe('some note');
    });

    it('converts date_begin ISO timestamp to YYYY-MM-DD', () => {
      const r = fn({ code: '1', date_begin: '2025-01-15T00:00:00.000Z' });
      expect(r.date_begin).toBe('2025-01-15');
    });

    it('sets null fields when missing', () => {
      const r = fn({ code: '1' });
      expect(r.note).toBeNull();
      expect(r.date_begin).toBeNull();
      expect(r.date_end).toBeNull();
    });
  });

  // ─── checkByInn ───────────────────────────────────────────────────────────

  describe('checkByInn', () => {
    it('returns is_bad_supplier=true when INN found in result', async () => {
      http.post.mockReturnValue(
        makeRpcResponse([{ code: '123456789', name: 'Bad LLC', note: null }]),
      );
      const result = await service.checkByInn('123456789');
      expect(result.is_bad_supplier).toBe(true);
      expect(result.record).toBeDefined();
      expect(result.inn).toBe('123456789');
    });

    it('returns is_bad_supplier=false when result is empty', async () => {
      http.post.mockReturnValue(makeRpcResponse([]));
      const result = await service.checkByInn('999999999');
      expect(result.is_bad_supplier).toBe(false);
      expect(result.record).toBeUndefined();
    });

    it('calls DB upsert after check', async () => {
      http.post.mockReturnValue(makeRpcResponse([]));
      await service.checkByInn('123');
      expect(db.query).toHaveBeenCalled();
    });
  });

  // ─── count ────────────────────────────────────────────────────────────────

  describe('count', () => {
    it('returns count from RPC response', async () => {
      http.post.mockReturnValue(of({ data: { result: { count: 14 } } } as any));
      expect(await service.count()).toBe(14);
    });

    it('returns 0 when result is null', async () => {
      http.post.mockReturnValue(of({ data: { result: null } } as any));
      expect(await service.count()).toBe(0);
    });
  });

  // ─── listAll ──────────────────────────────────────────────────────────────

  describe('listAll', () => {
    it('returns mapped records from RPC response', async () => {
      http.post.mockReturnValue(
        makeRpcResponse([
          { code: '111', name: 'A LLC' },
          { code: '222', name: 'B LLC' },
        ]),
      );
      const result = await service.listAll();
      expect(result).toHaveLength(2);
      expect(result[0].inn).toBe('111');
      expect(result[1].inn).toBe('222');
    });

    it('never asks for more than xt-xarid allows', async () => {
      // It asked for 500 and the source refuses anything over 100, so every
      // call came back as an RPC error and the endpoint answered 500.
      http.post.mockReturnValue(makeRpcResponse([{ code: '111' }]));
      await service.listAll();

      const body = http.post.mock.calls[0][1];
      expect(body.params.limit).toBeLessThanOrEqual(100);
    });

    it('stops after a short page', async () => {
      http.post.mockReturnValue(makeRpcResponse([{ code: '111' }]));
      await service.listAll();
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('keeps paging while pages come back full', async () => {
      const full = Array.from({ length: 100 }, (_, i) => ({ code: `${i}` }));
      http.post
        .mockReturnValueOnce(makeRpcResponse(full))
        .mockReturnValueOnce(makeRpcResponse(full))
        .mockReturnValueOnce(makeRpcResponse([{ code: 'last' }]));

      const result = await service.listAll();

      expect(http.post).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(201);
      expect(result[result.length - 1].inn).toBe('last');
      // Offsets advance by the page size, or paging would loop on page one.
      expect(http.post.mock.calls[0][1].params.offset).toBe(0);
      expect(http.post.mock.calls[1][1].params.offset).toBe(100);
      expect(http.post.mock.calls[2][1].params.offset).toBe(200);
    });

    it('returns an empty list rather than looping when the registry is empty', async () => {
      http.post.mockReturnValue(makeRpcResponse([]));
      const result = await service.listAll();
      expect(result).toEqual([]);
      expect(http.post).toHaveBeenCalledTimes(1);
    });
  });
});
