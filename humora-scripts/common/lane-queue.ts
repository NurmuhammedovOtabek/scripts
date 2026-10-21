import { Logger } from '@nestjs/common';

/**
 * `now` — somebody is waiting for the answer: a page view, a partner request,
 * an admin's call. `later` — nobody is: batch jobs, the people checks a
 * company page starts behind its response, refreshes of a stale answer.
 */
export type Lane = 'now' | 'later';

/**
 * One lookup at a time, with people who are waiting served first.
 *
 * The soliq.uz forms are captcha-gated and answered one session at a time,
 * so each service runs a single queue per process. It used to be one line in
 * arrival order: a company page that started twenty person lookups put every
 * site visitor and partner after them, and so did the nightly batch.
 *
 * A running lookup is never interrupted — it is mid-captcha — so a `now`
 * request waits for at most the one lookup already running, plus the `now`
 * requests ahead of it.
 *
 * **`later` is slowed down, never stopped.** While both lanes have work,
 * every `laterEvery`-th turn goes to `later` (default 4: three page views,
 * then one background lookup). On a quiet site the background lane runs at
 * full speed; on a site with no quiet moment it still gets a quarter of the
 * queue, so person checks and batch jobs finish late rather than never.
 */
export class LaneQueue {
  private readonly waiting: Record<Lane, Array<() => void>> = {
    now: [],
    later: [],
  };
  private running = false;
  private nowInARow = 0;

  constructor(
    private readonly name: string,
    private readonly logger?: Logger,
    private readonly laterEvery = 4,
  ) {}

  /** Lookups waiting in each lane (not counting the one running). */
  get sizes(): Record<Lane, number> {
    return { now: this.waiting.now.length, later: this.waiting.later.length };
  }

  run<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => this.next());
      };
      if (!this.running) {
        this.running = true;
        this.count(lane);
        start();
        return;
      }
      if (lane === 'now') {
        // Only the lane people wait in is logged: a delay a visitor feels
        // should be findable in Kibana, a long background backlog is normal.
        this.logger?.log(
          `[${this.name}] lane=now waiting behind ${this.waiting.now.length + 1} ` +
            `(later queue: ${this.waiting.later.length})`,
        );
      }
      this.waiting[lane].push(start);
    });
  }

  private next(): void {
    const lane = this.pick();
    if (!lane) {
      this.running = false;
      return;
    }
    this.count(lane);
    this.waiting[lane].shift()!();
  }

  private pick(): Lane | null {
    const { now, later } = this.waiting;
    if (!now.length) return later.length ? 'later' : null;
    if (!later.length) return 'now';
    return this.nowInARow >= this.laterEvery - 1 ? 'later' : 'now';
  }

  private count(lane: Lane): void {
    this.nowInARow = lane === 'now' ? this.nowInARow + 1 : 0;
  }
}
