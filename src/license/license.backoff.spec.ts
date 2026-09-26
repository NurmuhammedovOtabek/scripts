import { ServiceUnavailableException } from "@nestjs/common";
import { LicenseService, excerptBody } from "./license.service";
import { redact, stripAnsi } from "../common/log-file";

/**
 * The backoff, without a browser.
 *
 * These reach into the service's private state on purpose: the condition being
 * tested is one the registry decides, and there is no way to make Cloudflare
 * refuse us on demand. What can be pinned is what the service does once it has
 * decided it is being refused — answer immediately and locally, and stop
 * spending challenges.
 */
describe("LicenseService — challenge backoff", () => {
  const build = () => new LicenseService();

  it("refuses immediately while blocked, without driving the browser", async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() + 60_000;

    const started = Date.now();
    await expect(svc.getLicensesByTin("302114274")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // The point of the guard: a refusal costs nothing. Going to the registry
    // would take tens of seconds and burn another challenge.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(svc.browser).toBeNull();
  });

  it("says how long is left, so the caller can wait rather than hammer", async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() + 45_000;

    const err = await svc.getLicensesByTin("302114274").catch((e: any) => e);
    const body = err.getResponse();

    expect(body.retryAfterSec).toBeGreaterThan(40);
    expect(body.retryAfterSec).toBeLessThanOrEqual(45);
    expect(body.blockedUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts a refusal against the caller so the backoff is visible in stats", async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() + 60_000;

    await svc.getLicensesByTin("1").catch(() => undefined);
    await svc.getLicensesByTin("2").catch(() => undefined);

    // Rising while `failed` holds steady is what tells an operator the box is
    // deliberately sitting out rather than failing lookups.
    expect(svc.getStats().turnstileBlocked).toBe(2);
    expect(svc.getStats().failed).toBe(0);
  });

  it("lets lookups through once the block has expired", async () => {
    const svc = build() as any;
    svc.blockedUntil = Date.now() - 1;

    // Stubbed rather than left to run: past the guard the real code spawns
    // Chrome and walks a live registry, which a unit test must not do. What
    // matters here is only that the guard stepped aside.
    svc.ensureBrowser = jest
      .fn()
      .mockRejectedValue(new Error("no browser here"));

    const err = await svc.getLicensesByTin("302114274").catch((e: any) => e);

    expect(err).not.toBeInstanceOf(ServiceUnavailableException);
    expect(svc.ensureBrowser).toHaveBeenCalled();
    expect(svc.getStats().turnstileBlocked).toBe(0);
  });
});

describe("LicenseService — entering the backoff", () => {
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

  it("arms the backoff after three refusals in a row", async () => {
    const svc = failing("Turnstile token not obtained");

    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.blockedUntil).toBeGreaterThan(Date.now());
    expect(svc.turnstileStreak).toBe(3);
  });

  it("does not arm it before the third", async () => {
    const svc = failing("Turnstile token not obtained");

    await svc.getLicensesByTin("300000001").catch(() => undefined);
    await svc.getLicensesByTin("300000002").catch(() => undefined);

    // Two is bad luck; a browser respawn every time one lookup goes wrong
    // would cost more than it saves.
    expect(svc.blockedUntil).toBe(0);
  });

  it("refuses the next caller once armed, instead of asking again", async () => {
    const svc = failing("Turnstile token not obtained");
    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }
    const attemptsBefore = svc.ensureBrowser.mock.calls.length;

    const err = await svc.getLicensesByTin("300000009").catch((e: any) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    // The whole point: no further challenge is spent while the far side is
    // refusing.
    expect(svc.ensureBrowser.mock.calls.length).toBe(attemptsBefore);
    expect(svc.getStats().turnstileBlocked).toBe(1);
  });

  it("ignores failures that are not the challenge", async () => {
    // Chrome dying says nothing about whether the registry will talk to us.
    const svc = failing("Chrome died mid-lookup");

    for (let i = 0; i < 5; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.blockedUntil).toBe(0);
    expect(svc.turnstileStreak).toBe(0);
  });
});

describe("log redaction", () => {
  it("masks a PINFL but leaves a company TIN readable", () => {
    // mib logs both through the same `INN=` line, so only length tells them
    // apart: fourteen digits is a person, nine is a company.
    const line = "Form yuborilmoqda: INN=32003746860016, code=4";

    expect(redact(line)).toBe("Form yuborilmoqda: INN=[pinfl], code=4");
    expect(redact("TIN=302114274 — 6 cert(s)")).toBe(
      "TIN=302114274 — 6 cert(s)",
    );
  });

  it("masks every PINFL on a line, not just the first", () => {
    expect(redact("a=32003746860016 b=45010119900022")).toBe(
      "a=[pinfl] b=[pinfl]",
    );
  });

  it("strips the colour codes Nest writes for a terminal", () => {
    const esc = String.fromCharCode(27);
    expect(stripAnsi(`${esc}[32m[Nest]${esc}[39m ready`)).toBe("[Nest] ready");
  });
});

describe("LicenseService — idle shutdown", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("does not close the browser while a lookup is running", async () => {
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

  it("closes it once nothing is running", async () => {
    const svc = new LicenseService() as any;
    svc.disposeBrowser = jest.fn().mockResolvedValue(undefined);

    svc.busy = false;
    svc.scheduleIdleShutdown();
    jest.advanceTimersByTime(11 * 60 * 1000);

    expect(svc.disposeBrowser).toHaveBeenCalled();
  });

  it("closes it on the next round once the lookup ends", async () => {
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

describe("LicenseService — the real refusal path", () => {
  /**
   * Drives the path production actually takes: the browser works, the page
   * loads, and the challenge yields no token.
   *
   * The earlier tests stubbed `ensureBrowser` into rejecting, so execution
   * never reached the body of the try — and the reset that broke the backoff
   * lived exactly there. Both suites passed while the box failed twenty times
   * in a row without ever pausing. A stub placed above the bug proves nothing
   * about the bug.
   */
  const refusing = () => {
    const svc = new LicenseService() as any;
    svc.ensureBrowser = jest.fn().mockResolvedValue({
      contexts: () => [
        {
          newPage: async () => ({ close: async () => {}, context: () => ({}) }),
        },
      ],
      isConnected: () => true,
    });
    // No certificates and no token — the shape of a refused challenge.
    svc.captureTokenFromBrowser = jest
      .fn()
      .mockResolvedValue({
        token: "",
        uuids: [],
        certificates: [],
        total: null,
      });
    return svc;
  };

  it("arms the backoff after three refusals that reached the browser", async () => {
    const svc = refusing();

    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.turnstileStreak).toBe(3);
    expect(svc.blockedUntil).toBeGreaterThan(Date.now());
  });

  it("refuses the fourth caller without opening a browser", async () => {
    const svc = refusing();
    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }
    const opened = svc.ensureBrowser.mock.calls.length;

    const err = await svc.getLicensesByTin("300000009").catch((e: any) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(svc.ensureBrowser.mock.calls.length).toBe(opened);
  });

  it("a success clears the count, so an isolated refusal never accumulates", async () => {
    const svc = refusing();
    await svc.getLicensesByTin("300000001").catch(() => undefined);
    await svc.getLicensesByTin("300000002").catch(() => undefined);
    expect(svc.turnstileStreak).toBe(2);

    svc.captureTokenFromBrowser = jest.fn().mockResolvedValue({
      token: "t",
      uuids: [],
      certificates: [{ id: 1 }],
      total: 1,
    });
    await svc.getLicensesByTin("300000003");

    expect(svc.turnstileStreak).toBe(0);
    expect(svc.blockedUntil).toBe(0);
  });
});

describe("LicenseService — a company with no permits", () => {
  /**
   * The registry answers 200 with `{certificates: [], totalItems: 0}`.
   *
   * Until today that was thrown as "Turnstile token not obtained", so every
   * company holding nothing was retried twice, alerted to Telegram, and never
   * recorded — refetched on every page view for ever. Most of the failures on
   * 25 Aug were this, not a rate limit.
   */
  const holdingNone = () => {
    const svc = new LicenseService() as any;
    svc.ensureBrowser = jest.fn().mockResolvedValue({
      contexts: () => [
        {
          newPage: async () => ({ close: async () => {}, context: () => ({}) }),
        },
      ],
      isConnected: () => true,
    });
    svc.captureTokenFromBrowser = jest.fn().mockResolvedValue({
      token: "a-real-token",
      uuids: [],
      certificates: [],
      total: 0,
    });
    return svc;
  };

  it("answers with an empty list rather than throwing", async () => {
    const svc = holdingNone();

    await expect(svc.getLicensesByTin("302245864")).resolves.toEqual([]);
  });

  it("does not count towards the refusal backoff", async () => {
    // Three such companies in a row used to look identical to three refusals,
    // which would now pause the whole queue for ten minutes over nothing.
    const svc = holdingNone();

    for (let i = 0; i < 4; i++) {
      await svc.getLicensesByTin(`30000000${i}`);
    }

    expect(svc.turnstileStreak).toBe(0);
    expect(svc.blockedUntil).toBe(0);
  });

  it("records it as a success, counted as an empty result", async () => {
    const svc = holdingNone();

    await svc.getLicensesByTin("302245864");
    const s = svc.getStats();

    expect(s.ok).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.emptyResult).toBe(1);
  });

  it("still throws when the challenge never produced a token", async () => {
    // The distinction the whole fix rests on: no token means we never asked.
    const svc = holdingNone();
    svc.captureTokenFromBrowser = jest
      .fn()
      .mockResolvedValue({
        token: "",
        uuids: [],
        certificates: [],
        total: null,
      });

    await expect(svc.getLicensesByTin("300438878")).rejects.toThrow();
    expect(svc.turnstileStreak).toBe(1);
  });
});

describe("LicenseService — a registry that is slow to answer", () => {
  /**
   * The challenge is solved and the search goes out with its token, but the
   * registry answers later than the page waits.
   *
   * Measured 14 Sep: 31s for the search carrying the token, 35ms for the same
   * endpoint refusing a token-less request. The page used to wait a flat five
   * seconds and report "Turnstile token not obtained", which armed the
   * ten-minute backoff over a registry that was merely slow — and the backend
   * turned that into a stream of refusals and one alert per company.
   */
  const slowRegistry = (answered: boolean) => {
    const svc = new LicenseService() as any;
    svc.ensureBrowser = jest.fn().mockResolvedValue({
      contexts: () => [
        {
          newPage: async () => ({ close: async () => {}, context: () => ({}) }),
        },
      ],
      isConnected: () => true,
    });
    svc.captureTokenFromBrowser = jest.fn().mockResolvedValue({
      token: "a-real-token",
      uuids: [],
      certificates: [],
      total: null,
      answered,
    });
    return svc;
  };

  it("fails the lookup rather than reporting no permits", async () => {
    const svc = slowRegistry(false);

    await expect(svc.getLicensesByTin("311142996")).rejects.toThrow(
      /did not answer/,
    );
  });

  it("does not call it a Turnstile failure", async () => {
    const svc = slowRegistry(false);

    const err = await svc.getLicensesByTin("311142996").catch((e: any) => e);

    expect(String(err.message)).not.toMatch(/Turnstile/i);
  });

  it("does not arm the backoff, however many come in a row", async () => {
    const svc = slowRegistry(false);

    for (let i = 0; i < 5; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.turnstileStreak).toBe(0);
    expect(svc.blockedUntil).toBe(0);
  });

  it("counts it apart, so an operator can tell slow from refused", async () => {
    const svc = slowRegistry(false);

    await svc.getLicensesByTin("300000001").catch(() => undefined);
    await svc.getLicensesByTin("300000002").catch(() => undefined);
    const s = svc.getStats();

    expect(s.registryNoAnswer).toBe(2);
    expect(s.failed).toBe(2);
    expect(s.turnstileBlocked).toBe(0);
  });

  it("an answer with no count and nothing in it fails too — but is not a refusal", async () => {
    const svc = slowRegistry(true);

    const err = await svc.getLicensesByTin("311142996").catch((e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toMatch(/Turnstile/i);
    expect(svc.turnstileStreak).toBe(0);
    expect(svc.getStats().registryNoAnswer).toBe(0);
  });
});

describe("LicenseService — a registry that answers the search with an error", () => {
  /**
   * The challenge is solved, the search goes out with its token, and the
   * registry's own server gives up on it: HTTP 500 thirty seconds in, measured
   * 14 Sep in a slow spell, while the searches either side answered 200.
   */
  const failingRegistry = (
    searchStatus: number,
    searchBody: string | null = null,
  ) => {
    const svc = new LicenseService() as any;
    svc.ensureBrowser = jest.fn().mockResolvedValue({
      contexts: () => [
        {
          newPage: async () => ({ close: async () => {}, context: () => ({}) }),
        },
      ],
      isConnected: () => true,
    });
    svc.captureTokenFromBrowser = jest.fn().mockResolvedValue({
      token: "a-real-token",
      uuids: [],
      certificates: [],
      total: null,
      answered: true,
      searchStatus,
      searchBody,
    });
    return svc;
  };

  it("fails the lookup with the status the registry gave", async () => {
    const svc = failingRegistry(500);

    const err = await svc.getLicensesByTin("311142996").catch((e: any) => e);

    expect(String(err.message)).toMatch(/answered the search with HTTP 500/);
    expect(String(err.message)).not.toMatch(/did not answer/);
  });

  it("does not call it a Turnstile failure, or arm the backoff", async () => {
    const svc = failingRegistry(500);

    for (let i = 0; i < 5; i++) {
      const err = await svc
        .getLicensesByTin(`30000000${i}`)
        .catch((e: any) => e);
      expect(String(err.message)).not.toMatch(/Turnstile/i);
    }

    expect(svc.turnstileStreak).toBe(0);
    expect(svc.blockedUntil).toBe(0);
  });

  it("counts it apart from a registry that never answered", async () => {
    const svc = failingRegistry(502);

    await svc.getLicensesByTin("300000001").catch(() => undefined);
    const s = svc.getStats();

    expect(s.registryError).toBe(1);
    expect(s.registryNoAnswer).toBe(0);
    expect(s.failed).toBe(1);
  });

  it("treats a 429 as a refusal and backs off after three", async () => {
    const svc = failingRegistry(429);

    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.blockedUntil).toBeGreaterThan(Date.now());
    expect(svc.getStats().registryError).toBe(0);
  });

  it("calls a 400 the search being rejected, not the server failing", async () => {
    // 21 and 25 Sep: a quarter-hour of 400s, each after a solved challenge,
    // logged as "its own server failed".
    const svc = failingRegistry(400);

    const err = await svc.getLicensesByTin("311142996").catch((e: any) => e);

    expect(String(err.message)).toMatch(/rejected the search: HTTP 400/);
    expect(String(err.message)).not.toMatch(/own server failed/);
    expect(svc.getStats().registryRejected).toBe(1);
    expect(svc.getStats().registryError).toBe(0);
  });

  it("backs off after three 400s in a row, and refuses the fourth locally", async () => {
    const svc = failingRegistry(400);
    for (let i = 0; i < 3; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }
    const opened = svc.ensureBrowser.mock.calls.length;

    const err = await svc.getLicensesByTin("300000009").catch((e: any) => e);

    expect(svc.turnstileStreak).toBe(3);
    expect(svc.blockedUntil).toBeGreaterThan(Date.now());
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(svc.ensureBrowser.mock.calls.length).toBe(opened);
  });

  it("lets a server failure between them break the run", async () => {
    // Two 400s, then the server itself failing: that is not a third refusal.
    const svc = failingRegistry(400);
    await svc.getLicensesByTin("300000001").catch(() => undefined);
    await svc.getLicensesByTin("300000002").catch(() => undefined);
    svc.captureTokenFromBrowser.mockResolvedValueOnce({
      token: "a-real-token",
      uuids: [],
      certificates: [],
      total: null,
      answered: true,
      searchStatus: 500,
    });
    await svc.getLicensesByTin("300000003").catch(() => undefined);
    await svc.getLicensesByTin("300000004").catch(() => undefined);

    expect(svc.turnstileStreak).toBe(1);
    expect(svc.blockedUntil).toBe(0);
  });

  it("carries what the registry said into the failure", async () => {
    const svc = failingRegistry(400, '{"message":"invalid token"}');

    const err = await svc.getLicensesByTin("311142996").catch((e: any) => e);

    expect(String(err.message)).toContain(
      'registry said: {"message":"invalid token"}',
    );
    expect(svc.getStats().lastError).toContain("invalid token");
  });

  it("never lets the registry's words make a server failure a refusal", async () => {
    // A 500 whose body happens to mention the challenge is still the server
    // failing — classifying on it would pause every lookup for ten minutes.
    const svc = failingRegistry(500, "turnstile verification backend timeout");

    for (let i = 0; i < 4; i++) {
      await svc.getLicensesByTin(`30000000${i}`).catch(() => undefined);
    }

    expect(svc.turnstileStreak).toBe(0);
    expect(svc.blockedUntil).toBe(0);
  });
});

describe("excerptBody", () => {
  it("keeps only the title of an HTML error page", () => {
    const page = "<html><head><title>400 Bad Request</title></head><body>…</body></html>";
    expect(excerptBody(page)).toBe("400 Bad Request");
  });

  it("flattens a reply onto one line", () => {
    expect(excerptBody('{\n  "message": "bad"\n}')).toBe('{ "message": "bad" }');
  });

  it("cuts a long reply and says so", () => {
    const out = excerptBody("x".repeat(500), 10);
    expect(out).toBe(`${"x".repeat(10)}…`);
  });
});

describe("LicenseService — a walk a page would not finish", () => {
  const certs = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ uuid: `u-${from + i}` }));

  /** First page: 10 of `total`. Then one entry per fetchPage call, in order. */
  const walk = (pages: Array<any[] | null>, total = 39) => {
    const svc = new LicenseService() as any;
    svc.ensureBrowser = jest.fn().mockResolvedValue({
      contexts: () => [
        {
          newPage: async () => ({ close: async () => {}, context: () => ({}) }),
        },
      ],
      isConnected: () => true,
    });
    svc.captureTokenFromBrowser = jest.fn().mockResolvedValue({
      token: "a-real-token",
      uuids: [],
      certificates: certs(0, 10),
      total,
      answered: true,
      searchStatus: null,
    });
    svc.fetchPage = jest.fn();
    for (const p of pages) svc.fetchPage.mockResolvedValueOnce(p);
    return svc;
  };

  it("asks a page that did not answer once more, and finishes the walk", async () => {
    // Pages 2, 3 (after one miss) and 4: 10 + 10 + 10 + 9.
    const svc = walk([certs(10, 10), null, certs(20, 10), certs(30, 9)]);

    const result = await svc.getLicensesByTin("302699236");

    expect(result).toHaveLength(39);
    expect(svc.fetchPage).toHaveBeenCalledTimes(4);
    expect(svc.getStats().partialWalks).toBe(0);
  });

  it("fails rather than hand over part of the list as the whole of it", async () => {
    // 14 Sep: 30 of 39 came back 200 and would have been stored as complete.
    const svc = walk([certs(10, 10), certs(20, 10), null, null]);

    const err = await svc.getLicensesByTin("302699236").catch((e: any) => e);

    expect(String(err.message)).toMatch(/only part of the list: 30 of 39/);
    expect(String(err.message)).not.toMatch(/Turnstile/i);
    expect(svc.getStats().partialWalks).toBe(1);
    expect(svc.turnstileStreak).toBe(0);
  });

  it("still returns a walk whose pages simply ran out", async () => {
    // A count that disagrees with pages that all answered is the registry's
    // own inconsistency, not a failed page — returned with a warning, as before.
    const svc = walk([certs(10, 10), certs(20, 5)]);

    const result = await svc.getLicensesByTin("302699236");

    expect(result).toHaveLength(25);
    expect(svc.getStats().partialWalks).toBe(0);
  });
});
