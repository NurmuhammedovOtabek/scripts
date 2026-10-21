import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { NsSoatoMapSyncController } from './ns-soato-map-sync.controller';
import { NsSoatoMapSyncService } from './ns-soato-map-sync.service';

describe('NsSoatoMapSyncController', () => {
  let app: INestApplication;
  const service = { run: jest.fn(), status: jest.fn() };
  const SECRET = 'test-secret';
  const previous = process.env.ADMIN_SECRET;

  beforeAll(async () => {
    process.env.ADMIN_SECRET = SECRET;
    const mod = await Test.createTestingModule({
      controllers: [NsSoatoMapSyncController],
      providers: [{ provide: NsSoatoMapSyncService, useValue: service }],
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
    await request(app.getHttpServer()).post('/ns-soato-map/sync').expect(401);
    await request(app.getHttpServer()).get('/ns-soato-map/status').expect(401);
    expect(service.run).not.toHaveBeenCalled();
  });

  it('runs a real sync, or a dry one', async () => {
    service.run.mockResolvedValue({ dry: false, changed: [] });
    await as(request(app.getHttpServer()).post('/ns-soato-map/sync')).expect(
      201,
    );
    expect(service.run).toHaveBeenLastCalledWith({ dry: false }, 'manual');

    service.run.mockResolvedValue({ dry: true, changed: [] });
    await as(
      request(app.getHttpServer()).post('/ns-soato-map/sync?dry=1'),
    ).expect(201);
    expect(service.run).toHaveBeenLastCalledWith(
      { dry: true },
      'manual, dry run',
    );
  });

  it('says so when another replica is syncing, or the sync failed', async () => {
    service.run.mockResolvedValueOnce(null);
    await as(request(app.getHttpServer()).post('/ns-soato-map/sync'))
      .expect(201)
      .expect({ success: false, error: 'another replica is syncing' });
    service.run.mockRejectedValueOnce(
      new Error('cs.egov.uz answered HTTP 502'),
    );
    await as(request(app.getHttpServer()).post('/ns-soato-map/sync'))
      .expect(201)
      .expect({ success: false, error: 'cs.egov.uz answered HTTP 502' });
  });
});
