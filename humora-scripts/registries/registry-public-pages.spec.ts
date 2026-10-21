import { REGISTRY_ADAPTERS } from './registry-catalog';
import { REGISTRY_PUBLIC_PAGES } from './registry-public-pages';

describe('registry public pages', () => {
  it('names where every register is published', () => {
    const missing = REGISTRY_ADAPTERS.map((a) => a.meta.code).filter(
      (code) => !REGISTRY_PUBLIC_PAGES[code],
    );
    expect(missing).toEqual([]);
  });

  it('points at public https pages, not the APIs the adapters read', () => {
    for (const [code, page] of Object.entries(REGISTRY_PUBLIC_PAGES)) {
      expect({ code, ok: /^https:\/\/[^/]+/.test(page.url) }).toEqual({
        code,
        ok: true,
      });
      expect({ code, api: /\bapi[.-]|\/api\//.test(page.url) }).toEqual({
        code,
        api: false,
      });
      expect(page.name.uz && page.name.ru && page.name.en).toBeTruthy();
    }
  });

  it('lists no register the sync does not read', () => {
    const codes = new Set(REGISTRY_ADAPTERS.map((a) => a.meta.code));
    expect(
      Object.keys(REGISTRY_PUBLIC_PAGES).filter((c) => !codes.has(c)),
    ).toEqual([]);
  });
});
