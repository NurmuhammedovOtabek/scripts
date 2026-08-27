import { BirdarchaService } from './birdarcha.service';

/**
 * How a register response is classified.
 *
 * This is the whole bug that made every lookup fail: the register answers
 * HTTP 400 when it holds nothing, and anything non-200 was read as a broken
 * challenge — so a three-second "no such trader" became a sixty-second wait
 * and a 503 saying the register was unreachable.
 *
 * The listener is driven through a fake Playwright page rather than a browser:
 * the classification is the part that was wrong, and it needs no Chrome.
 */
type Handler = (resp: FakeResponse) => void;

interface FakeResponse {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Just enough of a Page for the response listener to attach to. */
const fakePage = () => {
  const handlers: Handler[] = [];
  return {
    page: { on: (_e: string, h: Handler) => handlers.push(h) } as never,
    emit: (r: FakeResponse) => handlers.forEach((h) => h(r)),
  };
};

const response = (status: number, body: unknown): FakeResponse => ({
  url: () =>
    'https://api.birdarcha.uz/v1/register/open-register/search?pin=1&lang=uz',
  status: () => status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** The register's real "nothing found" body, copied off the wire. */
const NO_CONTENT = {
  status: -1,
  message: {
    type: 'ERROR',
    message: {
      uz: 'Ma`lumot topilmadi',
      oz: 'Маълумот топилмади',
      ru: 'Данные не найдена',
      en: 'NO_CONTENT',
    },
  },
};

describe('BirdarchaService — reading the register', () => {
  const classify = (svc: BirdarchaService) =>
    (svc as unknown as {
      waitForRegisterResponse(p: unknown): Promise<{ kind: string }>;
    }).waitForRegisterResponse.bind(svc);

  it('reads a 400 that says NO_CONTENT as "no such trader"', async () => {
    const svc = new BirdarchaService();
    const { page, emit } = fakePage();

    const answer = classify(svc)(page);
    emit(response(400, NO_CONTENT));

    await expect(answer).resolves.toEqual({ kind: 'absent' });
  });

  it('reads a 200 as the record itself', async () => {
    const svc = new BirdarchaService();
    const { page, emit } = fakePage();

    const answer = classify(svc)(page);
    emit(response(200, { data: { name: 'A trader' } }));

    await expect(answer).resolves.toEqual({
      kind: 'body',
      body: { data: { name: 'A trader' } },
    });
  });

  it('does not settle on a 400 that means something else', async () => {
    // A real rejection must not be recorded as "this person is not registered"
    // — that is a statement about them made out of a failure of ours.
    jest.useFakeTimers();
    const svc = new BirdarchaService();
    const { page, emit } = fakePage();

    const answer = classify(svc)(page);
    emit(response(400, { message: 'Qayta yuklashda xato' }));
    await Promise.resolve();

    let settled = false;
    void answer.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(61_000);
    await expect(answer).resolves.toEqual({ kind: 'silent' });
    jest.useRealTimers();
  });

  it('ignores responses from anywhere else on the page', async () => {
    jest.useFakeTimers();
    const svc = new BirdarchaService();
    const { page, emit } = fakePage();

    const answer = classify(svc)(page);
    emit({
      url: () => 'https://new.birdarcha.uz/assets/index.js',
      status: () => 200,
      json: async () => ({ not: 'the register' }),
      text: async () => '',
    });

    jest.advanceTimersByTime(61_000);
    await expect(answer).resolves.toEqual({ kind: 'silent' });
    jest.useRealTimers();
  });

  it('refuses a PINFL that is not fourteen digits without opening a browser', async () => {
    const svc = new BirdarchaService();

    await expect(svc.getTraderByPinfl('123')).rejects.toThrow(/14 digits/);
    expect(svc.getStats().total).toBe(0);
  });
});
