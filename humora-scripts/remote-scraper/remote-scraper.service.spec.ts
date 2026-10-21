import axios from 'axios';
import { RemoteScraperService } from './remote-scraper.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * The mehnat route shares the box client with licences, whose "box is down"
 * alert must not fire because a government site behind the box is down.
 */
describe('RemoteScraperService — mehnat vacancies', () => {
  const OLD_ENV = process.env;
  let tg: { send: jest.Mock };
  let box: RemoteScraperService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, SCRIPT_SERVICE_URL: 'http://box.local:3002/' };
    tg = { send: jest.fn().mockResolvedValue(undefined) };
    box = new RemoteScraperService(tg as any);
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('asks the box by tin and returns its answer', async () => {
    const answer = { tin: '201056873', rows: [{ id: 1 }], details: {} };
    mockedAxios.get.mockResolvedValue({ status: 200, data: answer });

    await expect(box.getMehnatVacancies('201056873')).resolves.toEqual(answer);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://box.local:3002/mehnat/vacancies',
      expect.objectContaining({ params: { tin: '201056873' } }),
    );
  });

  it('treats a 502 as the site being down, not the box: no alert', async () => {
    mockedAxios.get.mockResolvedValue({ status: 502, data: {} });

    for (let i = 0; i < 5; i++) {
      await expect(box.getMehnatVacancies('201056873')).resolves.toBeNull();
    }
    expect(tg.send).not.toHaveBeenCalled();
  });

  it('still alerts when the box itself keeps failing', async () => {
    mockedAxios.get.mockResolvedValue({ status: 500, data: {} });

    for (let i = 0; i < 3; i++) {
      await expect(box.getMehnatVacancies('201056873')).resolves.toBeNull();
    }
    expect(tg.send).toHaveBeenCalledTimes(1);
  });

  it('is off without SCRIPT_SERVICE_URL', async () => {
    process.env = { ...OLD_ENV, SCRIPT_SERVICE_URL: '' };
    await expect(
      new RemoteScraperService(tg as any).getMehnatVacancies('201056873'),
    ).resolves.toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
