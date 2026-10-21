import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { JobControlController } from './job-control.controller';
import { JobControlService } from './job-control.service';

describe('JobControlController', () => {
  let app: INestApplication;
  const service = {
    status: jest.fn().mockResolvedValue({ jobs: [] }),
    stop: jest.fn().mockResolvedValue({ stop_requested: true }),
    unlock: jest.fn().mockResolvedValue({ released: false }),
  };
  const SECRET = 'test-secret';
  const previous = process.env.ADMIN_SECRET;

  beforeAll(async () => {
    process.env.ADMIN_SECRET = SECRET;
    const mod = await Test.createTestingModule({
      controllers: [JobControlController],
      providers: [{ provide: JobControlService, useValue: service }],
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
    await request(app.getHttpServer()).get('/jobs').expect(401);
    await request(app.getHttpServer()).post('/jobs/weekly/stop').expect(401);
    await request(app.getHttpServer()).post('/jobs/weekly/unlock').expect(401);
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.unlock).not.toHaveBeenCalled();
  });

  it('shows, stops and unlocks', async () => {
    await as(request(app.getHttpServer()).get('/jobs')).expect(200);
    await as(request(app.getHttpServer()).post('/jobs/weekly/stop')).expect(
      201,
    );
    expect(service.stop).toHaveBeenCalledWith('weekly');
    await as(
      request(app.getHttpServer()).post('/jobs/ns_soato_map/unlock'),
    ).expect(201);
    expect(service.unlock).toHaveBeenLastCalledWith('ns_soato_map', false);
    await as(
      request(app.getHttpServer()).post('/jobs/ns_soato_map/unlock?force=1'),
    ).expect(201);
    expect(service.unlock).toHaveBeenLastCalledWith('ns_soato_map', true);
  });
});
