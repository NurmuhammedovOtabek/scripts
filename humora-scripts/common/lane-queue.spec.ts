import { LaneQueue, Lane } from './lane-queue';

const flush = () => new Promise((r) => setImmediate(r));

/** A job that finishes when told to, recording when it started. */
function harness(queue: LaneQueue) {
  const started: string[] = [];
  const finish = new Map<string, (v?: unknown) => void>();
  const add = (lane: Lane, id: string) =>
    queue.run(
      lane,
      () =>
        new Promise((resolve) => {
          started.push(id);
          finish.set(id, resolve);
        }),
    );
  const done = async (id: string) => {
    finish.get(id)!();
    await flush();
  };
  return { started, add, done };
}

describe('LaneQueue', () => {
  it('runs one at a time', async () => {
    const q = harness(new LaneQueue('t'));
    void q.add('now', 'a');
    void q.add('now', 'b');
    await flush();
    expect(q.started).toEqual(['a']);
    await q.done('a');
    expect(q.started).toEqual(['a', 'b']);
  });

  it('serves a waiting page view before the background', async () => {
    const q = harness(new LaneQueue('t'));
    void q.add('later', 'bg1');
    void q.add('later', 'bg2');
    void q.add('now', 'page');
    await flush();
    // bg1 was already running and is not interrupted.
    expect(q.started).toEqual(['bg1']);
    await q.done('bg1');
    expect(q.started).toEqual(['bg1', 'page']);
    await q.done('page');
    expect(q.started).toEqual(['bg1', 'page', 'bg2']);
  });

  it('gives the background every fourth turn when the site never goes quiet', async () => {
    const q = harness(new LaneQueue('t'));
    void q.add('now', 'n0');
    for (let i = 1; i <= 6; i++) void q.add('now', `n${i}`);
    void q.add('later', 'bg');
    await flush();
    for (const id of ['n0', 'n1', 'n2']) await q.done(id);
    // n0, n1, n2 ran in a row; the next turn is the background's.
    expect(q.started).toEqual(['n0', 'n1', 'n2', 'bg']);
    await q.done('bg');
    expect(q.started[q.started.length - 1]).toBe('n3');
  });

  it('runs the background at full speed when nobody is waiting', async () => {
    const q = harness(new LaneQueue('t'));
    void q.add('later', 'a');
    void q.add('later', 'b');
    await flush();
    await q.done('a');
    expect(q.started).toEqual(['a', 'b']);
  });

  it('passes results and errors through, and keeps going after an error', async () => {
    const queue = new LaneQueue('t');
    const failed = queue.run('now', () => Promise.reject(new Error('captcha')));
    const ok = queue.run('now', () => Promise.resolve(42));
    await expect(failed).rejects.toThrow('captcha');
    await expect(ok).resolves.toBe(42);
  });

  it('keeps going after a job that throws before returning a promise', async () => {
    const queue = new LaneQueue('t');
    const failed = queue.run('now', (() => {
      throw new Error('sync');
    }) as any);
    await expect(failed).rejects.toThrow('sync');
    await expect(
      queue.run('later', () => Promise.resolve('next')),
    ).resolves.toBe('next');
  });

  it('reports what is waiting', async () => {
    const queue = new LaneQueue('t');
    const q = harness(queue);
    void q.add('now', 'a');
    void q.add('now', 'b');
    void q.add('later', 'c');
    await flush();
    expect(queue.sizes).toEqual({ now: 1, later: 1 });
  });
});
