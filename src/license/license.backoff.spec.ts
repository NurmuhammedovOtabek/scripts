import { ServiceUnavailableException } from '@nestjs/common';
import { LicenseService } from './license.service';
import { redact, stripAnsi } from '../common/log-file';

/**
 * The backoff, without a browser.
 *
 * These reach into the service's private state on purpose: the condition being
 * tested is one the registry decides, and there is no way to make Cloudflare
 * refuse us on demand. What can be pinned is what the service does once it has
 * decided it is being refused — answer immediately and locally, and stop
 * spending challenges.
 */
describe('LicenseService — challenge backoff', () => {
  const build = () => new LicenseService();

  it('refuses immediately while blocked, without driving the browser', async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() + 60_000;

    const started = Date.now();
    await expect(svc.getLicensesByTin('302114274')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // The point of the guard: a refusal costs nothing. Going to the registry
    // would take tens of seconds and burn another challenge.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(svc.browser).toBeNull();
  });

  it('says how long is left, so the caller can wait rather than hammer', async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() + 45_000;

    const err = await svc.getLicensesByTin('302114274').catch((e: any) => e);
    const body = err.getResponse();

    expect(body.retryAfterSec).toBeGreaterThan(40);
    expect(body.retryAfterSec).toBeLessThanOrEqual(45);
    expect(body.blockedUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('counts a refusal against the caller so the backoff is visible in stats', async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() + 60_000;

    await svc.getLicensesByTin('1').catch(() => undefined);
    await svc.getLicensesByTin('2').catch(() => undefined);

    // Rising while `failed` holds steady is what tells an operator the box is
    // deliberately sitting out rather than failing lookups.
    expect(svc.getStats().turnstileBlocked).toBe(2);
    expect(svc.getStats().failed).toBe(0);
  });

  it('lets lookups through once the block has expired', async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() - 1;

    // Stubbed rather than left to run: past the guard the real code spawns
    // Chrome and walks a live registry, which a unit test must not do. What
    // matters here is only that the guard stepped aside.
    svc.ensureBrowser = jest
      .fn()
      .mockRejectedValue(new Error('no browser here'));

    const err = await svc.getLicensesByTin('302114274').catch((e: any) => e);

    expect(err).not.toBeInstanceOf(ServiceUnavailableException);
    expect(svc.ensureBrowser).toHaveBeenCalled();
    expect(svc.getStats().turnstileBlocked).toBe(0);
  });
});

describe('LicenseService — entering the backoff', () => {
  /**
   * Drives the real failure path rather than setting `blockedUntil` by hand.
   *
   * The tests above did set it by hand, and passed while the code that was
   * supposed to set it had never made it into the file at all — the box then
   * failed a challenge twenty times in a row without ever pausing. A guard is
   * only worth as much as the thing that arms it.
   */
  const failing = (message: string) => {
    const svc = new LicenseService() as any;
    svc.ensureBrowser = jest.fn().mockRejectedValue(new Error(message));
    return svc;
  };

  it('arms the backoff after three refusals in a row', async () => {
    const svc = failing('Turnstile token not obtained');

    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.blockedUntil).toBeGreaterThan(Date.now());
    expect(svc.turnstileStreak).toBe(3);
  });

  it('does not arm it before the third', async () => {
    const svc = failing('Turnstile token not obtained');

    await svc.getLicensesByTin('300000001').catch(() => undefined);
    await svc.getLicensesByTin('300000002').catch(() => undefined);

    // Two is bad luck; a browser respawn every time one lookup goes wrong
    // would cost more than it saves.
    expect(svc.blockedUntil).toBe(0);
  });

  it('refuses the next caller once armed, instead of asking again', async () => {
    const svc = failing('Turnstile token not obtained');
    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }
    const attemptsBefore = svc.ensureBrowser.mock.calls.length;

    const err = await svc.getLicensesByTin('300000009').catch((e: any) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    // The whole point: no further challenge is spent while the far side is
    // refusing.
    expect(svc.ensureBrowser.mock.calls.length).toBe(attemptsBefore);
    expect(svc.getStats().turnstileBlocked).toBe(1);
  });

  it('ignores failures that are not the challenge', async () => {
    // Chrome dying says nothing about whether the registry will talk to us.
    const svc = failing('Chrome died mid-lookup');

    for (let i = 0; i < 5; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.blockedUntil).toBe(0);
    expect(svc.turnstileStreak).toBe(0);
  });
});

describe('log redaction', () => {
  it('masks a PINFL but leaves a company TIN readable', () => {
    // mib logs both through the same `INN=` line, so only length tells them
    // apart: fourteen digits is a person, nine is a company.
    const line = 'Form yuborilmoqda: INN=32003746860016, code=4';

    expect(redact(line)).toBe('Form yuborilmoqda: INN=[pinfl], code=4');
    expect(redact('TIN=302114274 — 6 cert(s)')).toBe(
      'TIN=302114274 — 6 cert(s)',
    );
  });

  it('masks every PINFL on a line, not just the first', () => {
    expect(redact('a=32003746860016 b=45010119900022')).toBe(
      'a=[pinfl] b=[pinfl]',
    );
  });

  it('strips the colour codes Nest writes for a terminal', () => {
    const esc = String.fromCharCode(27);
    expect(stripAnsi(`${esc}[32m[Nest]${esc}[39m ready`)).toBe('[Nest] ready');
  });
});

describe('LicenseService — idle shutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not close the browser while a lookup is running', async () => {
    // What happened on 25 Aug: the countdown from one lookup elapsed during
    // the next one, Chrome went away underneath it, and the failure was
    // reported as the registry refusing us.
    const svc = new LicenseService() as any;
    svc.disposeBrowser = jest.fn().mockResolvedValue(undefined);

    svc.busy = true;
    svc.scheduleIdleShutdown();
    jest.advanceTimersByTime(11 * 60 * 1000);

    expect(svc.disposeBrowser).not.toHaveBeenCalled();
  });

  it('closes it once nothing is running', async () => {
    const svc = new LicenseService() as any;
    svc.disposeBrowser = jest.fn().mockResolvedValue(undefined);

    svc.busy = false;
    svc.scheduleIdleShutdown();
    jest.advanceTimersByTime(11 * 60 * 1000);

    expect(svc.disposeBrowser).toHaveBeenCalled();
  });

  it('closes it on the next round once the lookup ends', async () => {
    // Deferring must not mean never: the memory is worth reclaiming.
    const svc = new LicenseService() as any;
    svc.disposeBrowser = jest.fn().mockResolvedValue(undefined);

    svc.busy = true;
    svc.scheduleIdleShutdown();
    jest.advanceTimersByTime(11 * 60 * 1000);
    expect(svc.disposeBrowser).not.toHaveBeenCalled();

    svc.busy = false;
    jest.advanceTimersByTime(11 * 60 * 1000);
    expect(svc.disposeBrowser).toHaveBeenCalled();
  });
});
