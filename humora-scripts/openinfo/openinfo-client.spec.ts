import { OpeninfoClient } from './openinfo-client';

/** A client whose pages come from a list instead of the portal. */
function clientWith(
  pages: Array<{
    count: number;
    next: string | null;
    results: unknown[];
  } | null>,
) {
  const client = new OpeninfoClient();
  let i = 0;
  (client as any).get = jest.fn(async () => pages[i++]);
  return client;
}

describe('OpeninfoClient.eachPage', () => {
  it('hands each page over as it arrives and says the list ended', async () => {
    const client = clientWith([
      { count: 3, next: 'p2', results: [1, 2] },
      { count: 3, next: null, results: [3] },
    ]);
    const seen: unknown[][] = [];
    const res = await client.eachPage('x/', {}, async (rows) => {
      seen.push(rows);
    });
    expect(seen).toEqual([[1, 2], [3]]);
    expect(res).toEqual({ count: 3, pages: 2, read: 3, ended: true });
  });

  it('a page the portal no longer has (404) ends the walk unfinished', async () => {
    const client = clientWith([
      { count: 5, next: 'p2', results: [1, 2] },
      null,
    ]);
    const res = await client.eachPage('x/', {}, async () => undefined);
    expect(res.ended).toBe(false);
    expect(res.read).toBe(2);
  });

  it('a list that stops short of its own count is not ended', async () => {
    const client = clientWith([{ count: 5, next: null, results: [1, 2] }]);
    expect((await client.eachPage('x/', {}, async () => undefined)).ended).toBe(
      false,
    );
  });

  it('stops when the handler says so', async () => {
    const client = clientWith([
      { count: 4, next: 'p2', results: [1, 2] },
      { count: 4, next: null, results: [3, 4] },
    ]);
    const res = await client.eachPage('x/', {}, async () => false);
    expect(res).toMatchObject({ pages: 1, read: 2, ended: false });
  });

  it('all() still returns every row', async () => {
    const client = clientWith([
      { count: 3, next: 'p2', results: [1, 2] },
      { count: 3, next: null, results: [3] },
    ]);
    expect(await client.all('x/')).toEqual({
      count: 3,
      rows: [1, 2, 3],
      pages: 2,
    });
  });
});
