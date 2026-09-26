import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { MehnatService, rowsForTin } from './mehnat.service';

const row = (id: number, tin = '201056873') => ({
  id,
  company_tin: tin,
  position_name: 'Texnik',
});
const list = (rows: any[]) => ({
  success: true,
  data: { data: rows, total: rows.length },
});

function make(answer: (url: string) => { status: number; data?: any }) {
  const calls: string[] = [];
  const http = {
    get: jest.fn((url: string) => {
      calls.push(url);
      return of(answer(url));
    }),
  };
  return { service: new MehnatService(http as any), http, calls };
}

describe('MehnatService', () => {
  it('returns the employer rows and each posting page', async () => {
    const { service } = make((url) =>
      url.endsWith('/vacancies')
        ? { status: 200, data: list([row(1), row(2)]) }
        : {
            status: 200,
            data: {
              data: { id: Number(url.split('/').pop()), position_duties: 'x' },
            },
          },
    );

    const res = await service.getVacancies('201056873');

    expect(res.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(res.details).toEqual({
      '1': { id: 1, position_duties: 'x' },
      '2': { id: 2, position_duties: 'x' },
    });
  });

  it('keeps the row when its posting page fails', async () => {
    const { service } = make((url) =>
      url.endsWith('/vacancies')
        ? { status: 200, data: list([row(1)]) }
        : { status: 500 },
    );

    const res = await service.getVacancies('201056873');

    expect(res.rows).toHaveLength(1);
    expect(res.details).toEqual({ '1': null });
  });

  it('never passes on rows of another company', async () => {
    const { service, calls } = make(() => ({
      status: 200,
      data: list([row(1, '999999999'), row(2, '888888888')]),
    }));

    const res = await service.getVacancies('201056873');

    expect(res.rows).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('answers 502 when the list cannot be read, not an empty list', async () => {
    const { service } = make(() => ({ status: 503 }));
    await expect(service.getVacancies('201056873')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('rejects a malformed tin without calling the source', async () => {
    const { service, http } = make(() => ({ status: 200, data: list([]) }));
    await expect(service.getVacancies('12ab')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(http.get).not.toHaveBeenCalled();
  });

  it('asks the source by company_tin', async () => {
    const { service, http } = make(() => ({ status: 200, data: list([]) }));
    await service.getVacancies('201056873');
    expect((http.get.mock.calls[0] as any[])[1].params).toEqual({
      company_tin: '201056873',
      limit: 100,
    });
  });
});

describe('rowsForTin', () => {
  it('survives a body without rows', () => {
    expect(rowsForTin(null, '1')).toEqual([]);
    expect(rowsForTin({ data: { data: 'x' } }, '1')).toEqual([]);
  });
});
