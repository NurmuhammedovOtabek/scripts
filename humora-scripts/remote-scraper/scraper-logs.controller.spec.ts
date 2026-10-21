import { Test } from '@nestjs/testing';
import axios from 'axios';
import { ScraperLogsController } from './scraper-logs.controller';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const res = () => ({ type: jest.fn() }) as any;

describe('ScraperLogsController', () => {
  let controller: ScraperLogsController;
  const env = { ...process.env };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ScraperLogsController],
    }).compile();
    controller = moduleRef.get(ScraperLogsController);

    process.env.ADMIN_SECRET = 'right-secret';
    process.env.SCRIPT_SERVICE_URL = 'http://box:3002';
    process.env.SCRIPT_LOGS_TOKEN = 'box-token';
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = env;
  });

  it('refuses without the admin secret', async () => {
    await expect(controller.logs(res(), undefined)).rejects.toMatchObject({
      status: 401,
    });
    // Nothing should reach the box before the caller is known.
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('refuses a wrong admin secret', async () => {
    await expect(controller.logs(res(), 'guess')).rejects.toMatchObject({
      status: 401,
    });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('refuses everyone when ADMIN_SECRET is unset', async () => {
    // An unconfigured deployment must be closed, not open — the opposite
    // default would publish the box's log to anyone who found the path.
    delete process.env.ADMIN_SECRET;
    await expect(controller.logs(res(), 'anything')).rejects.toMatchObject({
      status: 401,
    });
  });

  it("forwards the box token and the caller's filters", async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: '# log\nline' });

    const out = await controller.logs(res(), 'right-secret', '50', 'Turnstile');

    expect(out).toContain('line');
    const [url, cfg] = mockedAxios.get.mock.calls[0];
    expect(url).toBe('http://box:3002/logs');
    expect(cfg?.headers?.['x-logs-token']).toBe('box-token');
    expect(cfg?.params).toEqual({ lines: '50', q: 'Turnstile' });
  });

  it('names the likely cause when the box rejects the token', async () => {
    // The two tokens drifting apart is the failure this will actually hit,
    // and a bare 403 would send someone looking at the wrong machine.
    mockedAxios.get.mockResolvedValue({ status: 403, data: 'forbidden' });

    await expect(controller.logs(res(), 'right-secret')).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('does not match LOGS_TOKEN'),
      }),
    });
  });

  it('says the box is unreachable rather than failing opaquely', async () => {
    mockedAxios.get.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(controller.logs(res(), 'right-secret')).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('Could not reach the scraper box'),
      }),
    });
  });

  it('explains which setting is missing', async () => {
    delete process.env.SCRIPT_LOGS_TOKEN;

    await expect(controller.logs(res(), 'right-secret')).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('SCRIPT_LOGS_TOKEN is not set'),
      }),
    });
  });
});
