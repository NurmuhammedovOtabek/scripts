import axios from 'axios';
import { Logger } from '@nestjs/common';
import {
  TelegramAlertService,
  splitAlert,
  withTag,
} from './telegram-alert.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const httpError = (status: number, description: string, extra: object = {}) =>
  Object.assign(new Error(description), {
    response: { status, data: { description, ...extra } },
  });

describe('TelegramAlertService', () => {
  const env = { ...process.env };
  let service: TelegramAlertService;
  const delays = TelegramAlertService.retryDelaysMs;

  beforeEach(() => {
    post.mockReset();
    process.env.BOT_TOKEN = 'token';
    process.env.TG_ALERT_CHAT_ID = 'chat';
    process.env.SERVICE_ENVIRONMENT = 'development';
    TelegramAlertService.retryDelaysMs = [1, 1, 1];
    service = new TelegramAlertService();
  });

  afterAll(() => {
    process.env = env;
    TelegramAlertService.retryDelaysMs = delays;
  });

  const sentTexts = () =>
    post.mock.calls.map(([, body]) => body.text as string);

  it('tags the environment from SERVICE_ENVIRONMENT', async () => {
    post.mockResolvedValue({});
    expect(await service.deliver('<b>hi</b>')).toBe(true);
    expect(sentTexts()[0]).toBe('🟡 <b>DEVELOPMENT</b>\n<b>hi</b>');
  });

  it('waits out a 429 and tries again', async () => {
    post
      .mockRejectedValueOnce(
        httpError(429, 'Too Many Requests', { parameters: { retry_after: 0 } }),
      )
      .mockResolvedValue({});
    expect(await service.deliver('report')).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure and a 5xx, four attempts in all', async () => {
    post.mockRejectedValue(new Error('socket hang up'));
    expect(await service.deliver('report')).toBe(false);
    expect(post).toHaveBeenCalledTimes(4);
  });

  it('does not retry a request Telegram refuses outright', async () => {
    post.mockRejectedValue(httpError(403, 'Forbidden: bot was kicked'));
    expect(await service.deliver('report')).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends the words as plain text when the markup is refused', async () => {
    post
      .mockRejectedValueOnce(
        httpError(400, "Bad Request: can't parse entities"),
      )
      .mockResolvedValue({});
    expect(await service.deliver('<b>x</b> 5 &lt; 6')).toBe(true);
    const plain = post.mock.calls[1][1];
    expect(plain.parse_mode).toBeUndefined();
    expect(plain.text).toBe('🟡 DEVELOPMENT\nx 5 < 6');
  });

  it('sends a long report in pieces', async () => {
    post.mockResolvedValue({});
    const long = Array.from(
      { length: 400 },
      (_, i) => `line ${i} ${'x'.repeat(20)}`,
    ).join('\n');
    expect(await service.deliver(long)).toBe(true);
    expect(post.mock.calls.length).toBeGreaterThan(1);
    for (const text of sentTexts())
      expect(text.length).toBeLessThanOrEqual(3800);
  });

  it('holds a send() caller for one attempt and retries behind it', async () => {
    post.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue({});
    expect(await service.send('report')).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('sends nothing, and says so, where alerts are off', async () => {
    delete process.env.BOT_TOKEN;
    expect(await service.send('report')).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('puts the hashtag under the environment', async () => {
    post.mockResolvedValue({});
    expect(await service.deliver('<b>Suspended</b>', { tag: 'blocked' })).toBe(
      true,
    );
    expect(sentTexts()[0]).toBe(
      '🟡 <b>DEVELOPMENT</b>\n#blocked\n<b>Suspended</b>',
    );
    await service.send('Bank list synced', { tag: 'bank_registry' });
    expect(sentTexts()[1]).toBe(
      '🟡 <b>DEVELOPMENT</b>\n#bank_registry\nBank list synced',
    );
  });

  it('puts several hashtags on the one line, the kind first', async () => {
    post.mockResolvedValue({});
    expect(
      await service.deliver('<b>Suspicious activity</b>', {
        tag: ['suspicious', 'non_browser'],
      }),
    ).toBe(true);
    expect(sentTexts()[0]).toBe(
      '🟡 <b>DEVELOPMENT</b>\n#suspicious #non_browser\n<b>Suspicious activity</b>',
    );
    await service.send('Suspended', { tag: ['blocked', 'volume'] });
    expect(sentTexts()[1]).toBe(
      '🟡 <b>DEVELOPMENT</b>\n#blocked #volume\nSuspended',
    );
  });

  it('logs what an alert with several hashtags was about', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    delete process.env.BOT_TOKEN;
    await service.send('⚠️ <b>Suspicious activity</b> — volume', {
      tag: ['suspicious', 'volume'],
    });
    expect(log).toHaveBeenCalledWith(
      '[telegram] not sent (alerts off): #suspicious #volume ⚠️ Suspicious activity — volume',
    );
    log.mockRestore();
  });

  it('logs what a tagged alert was about, not just its hashtag', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    delete process.env.BOT_TOKEN;
    await service.send('⛔ <b>Limit reached</b> — companies-day', {
      tag: 'limit',
    });
    expect(log).toHaveBeenCalledWith(
      '[telegram] not sent (alerts off): #limit ⛔ Limit reached — companies-day',
    );
    log.mockRestore();
  });
});

describe('withTag', () => {
  it('leaves a text without options as it is', () => {
    expect(withTag('report', {})).toBe('report');
    expect(withTag('report')).toBe('report');
  });

  it.each([
    ['limit', '#limit'],
    ['bank_registry', '#bank_registry'],
    ['ns-soato', '#ns_soato'],
    ['New Companies', '#new_companies'],
    ['OKED', '#oked'],
    ['<b>x</b>', '#_b_x__b_'],
  ])('writes the tag %p as a hashtag Telegram can search: %s', (tag, line) => {
    expect(withTag('report', { tag })).toBe(`${line}\nreport`);
  });

  it('adds no tag line for an empty tag', () => {
    expect(withTag('report', { tag: '' })).toBe('report');
    expect(withTag('report', { tag: [] })).toBe('report');
    expect(withTag('report', { tag: ['', ''] })).toBe('report');
  });

  it('writes several tags as hashtags on one line, each once, in order', () => {
    expect(
      withTag('report', {
        tag: ['suspicious', 'non-browser', '', 'suspicious', 'Volume'],
      }),
    ).toBe('#suspicious #non_browser #volume\nreport');
    expect(withTag('report', { tag: ['limit'] })).toBe('#limit\nreport');
  });
});

describe('splitAlert', () => {
  it('keeps a short text whole and cuts on line breaks', () => {
    expect(splitAlert('a\nb', 10)).toEqual(['a\nb']);
    expect(splitAlert('aaaa\nbbbb\ncccc', 10)).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(splitAlert('x'.repeat(25), 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(5),
    ]);
  });
});
