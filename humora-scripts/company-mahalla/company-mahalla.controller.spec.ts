import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { CompanyMahallaController } from './company-mahalla.controller';
import { CompanyMahallaService } from './company-mahalla.service';

describe('CompanyMahallaController', () => {
  let app: INestApplication;
  const service = {
    start: jest.fn(),
    requestStop: jest.fn(),
    status: jest.fn(),
    refreshInns: jest.fn(),
    listUnmatched: jest.fn(),
    explain: jest.fn(),
    listVillageMap: jest.fn(),
    setVillageMappings: jest.fn(),
    existingMahallas: jest.fn(),
  };
  const SECRET = 'test-secret';
  const previous = process.env.ADMIN_SECRET;

  beforeAll(async () => {
    process.env.ADMIN_SECRET = SECRET;
    const mod = await Test.createTestingModule({
      controllers: [CompanyMahallaController],
      providers: [{ provide: CompanyMahallaService, useValue: service }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.ADMIN_SECRET = previous;
  });

  beforeEach(() => jest.clearAllMocks());

  const as = (req: request.Test) => req.set('x-admin-secret', SECRET);

  it('refuses a caller without the admin secret', async () => {
    await request(app.getHttpServer()).post('/company-mahalla/run').expect(401);
    await request(app.getHttpServer())
      .get('/company-mahalla/status')
      .expect(401);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('starts a real run, or a dry one', async () => {
    service.start.mockResolvedValue({
      started: true,
      reason: null,
      done: Promise.resolve(),
    });
    await as(request(app.getHttpServer()).post('/company-mahalla/run'))
      .expect(201)
      .expect({ started: true, reason: null, dry: false });
    expect(service.start).toHaveBeenLastCalledWith({ dry: false }, 'manual');

    await as(request(app.getHttpServer()).post('/company-mahalla/run?dry=1'))
      .expect(201)
      .expect({ started: true, reason: null, dry: true });
    expect(service.start).toHaveBeenLastCalledWith(
      { dry: true },
      'manual, dry run',
    );
  });

  it('explains one company and refuses what is not a STIR', async () => {
    service.explain.mockResolvedValue({ inn: '300000001', found: true });
    await as(
      request(app.getHttpServer()).get('/company-mahalla/inn/300000001'),
    ).expect(200);
    await as(
      request(app.getHttpServer()).get('/company-mahalla/inn/abc'),
    ).expect(400);
  });

  it('resolves one company on request', async () => {
    service.refreshInns.mockResolvedValue({
      resolved: 1,
      changed: 1,
      removed: 0,
    });
    await as(
      request(app.getHttpServer()).post(
        '/company-mahalla/inn/300000001/refresh',
      ),
    )
      .expect(201)
      .expect({ resolved: 1, changed: 1, removed: 0 });
    expect(service.refreshInns).toHaveBeenCalledWith(['300000001']);
    await as(
      request(app.getHttpServer()).post('/company-mahalla/inn/x/refresh'),
    ).expect(400);
  });

  it('lists the commonest unmatched names, and checks what it is asked', async () => {
    service.listUnmatched.mockResolvedValue({ total: 0, groups: [] });
    await as(
      request(app.getHttpServer()).get('/company-mahalla/unmatched'),
    ).expect(200);
    expect(service.listUnmatched).toHaveBeenLastCalledWith(
      'not_found',
      100,
      null,
    );
    await as(
      request(app.getHttpServer()).get(
        '/company-mahalla/unmatched?reason=ambiguous&district=1726266&limit=20',
      ),
    ).expect(200);
    expect(service.listUnmatched).toHaveBeenLastCalledWith(
      'ambiguous',
      20,
      '1726266',
    );
    for (const q of [
      'reason=matched',
      'district=17',
      'limit=0',
      'limit=5000',
    ]) {
      await as(
        request(app.getHttpServer()).get(`/company-mahalla/unmatched?${q}`),
      ).expect(400);
    }
    await request(app.getHttpServer())
      .get('/company-mahalla/unmatched')
      .expect(401);
  });

  it('validates the village-map listing', async () => {
    service.listVillageMap.mockResolvedValue([]);
    await as(
      request(app.getHttpServer()).get(
        '/company-mahalla/village-map?status=review',
      ),
    ).expect(200);
    expect(service.listVillageMap).toHaveBeenCalledWith('review', 200);
    await as(
      request(app.getHttpServer()).get(
        '/company-mahalla/village-map?status=bogus',
      ),
    ).expect(400);
    await as(
      request(app.getHttpServer()).get('/company-mahalla/village-map?limit=0'),
    ).expect(400);
  });

  describe('manual village mappings', () => {
    const put = (body: unknown) =>
      as(request(app.getHttpServer()).put('/company-mahalla/village-map')).send(
        body as object,
      );

    it('saves known mahallas, a null, and a reset', async () => {
      service.existingMahallas.mockResolvedValue(new Set(['1730401016']));
      service.setVillageMappings.mockResolvedValue({
        saved: 2,
        reset: 1,
        queued: 5,
      });
      await put({
        items: [
          { villageCode: '8096', mahallaCode: '1730401016' },
          { villageCode: '7538', mahallaCode: null },
          { villageCode: '7283', reset: true },
        ],
      }).expect(200);
      expect(service.setVillageMappings).toHaveBeenCalledWith([
        { villageCode: '8096', mahallaCode: '1730401016', reset: false },
        { villageCode: '7538', mahallaCode: null, reset: false },
        { villageCode: '7283', mahallaCode: null, reset: true },
      ]);
    });

    it('refuses a code that is not a mahalla', async () => {
      service.existingMahallas.mockResolvedValue(new Set());
      await put({
        items: [{ villageCode: '8096', mahallaCode: '1730401999' }],
      }).expect(400);
      expect(service.setVillageMappings).not.toHaveBeenCalled();
    });

    it.each([
      [{}],
      [{ items: [] }],
      [{ items: [{ villageCode: 'x', mahallaCode: null }] }],
      [{ items: [{ villageCode: '8096' }] }],
      [{ items: [{ villageCode: '8096', mahallaCode: '123' }] }],
    ])('refuses %j', async (body) => {
      await put(body).expect(400);
    });
  });
});
