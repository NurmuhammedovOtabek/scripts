import { HostPacer, RegistryHttp, SourceRefusedError } from './registry-http';

describe('RegistryHttp', () => {
  const answer = (status: number, data: unknown = {}) =>
    Promise.resolve({ status, data, headers: {} });

  it('waits between two requests to one host, not between two hosts', async () => {
    const waits: number[] = [];
    const pacer = new HostPacer(1500, async (ms) => {
      waits.push(ms);
    });
    const send = jest.fn(() => answer(200));
    const http = new RegistryHttp(pacer, null, send, 0);
    await http.get('https://a.example/x');
    await http.get('https://b.example/y');
    expect(waits).toHaveLength(0);
    await http.get('https://a.example/z');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(1000);
  });

  it('stops on a refusal without asking again', async () => {
    const send = jest.fn(() => answer(429));
    const http = new RegistryHttp(new HostPacer(0), null, send, 0);
    await expect(http.get('https://a.example/x')).rejects.toBeInstanceOf(
      SourceRefusedError,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('asks once more after a server error, never after a 404', async () => {
    const send = jest
      .fn()
      .mockReturnValueOnce(answer(502))
      .mockReturnValueOnce(answer(200, { ok: true }));
    const http = new RegistryHttp(new HostPacer(0), null, send, 0);
    await expect(http.get('https://a.example/x')).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(send).toHaveBeenCalledTimes(2);

    const missing = jest.fn(() => answer(404));
    const http2 = new RegistryHttp(new HostPacer(0), null, missing, 0);
    await expect(http2.get('https://a.example/x')).rejects.toThrow(/HTTP 404/);
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('counts requests against a trial limit', async () => {
    const send = jest.fn(() => answer(200));
    const http = new RegistryHttp(new HostPacer(0), 2, send, 0);
    await http.get('https://a.example/1');
    expect(http.spent).toBe(false);
    await http.get('https://a.example/2');
    expect(http.spent).toBe(true);
    await expect(http.get('https://a.example/3')).rejects.toThrow(/limit/);
  });
});
