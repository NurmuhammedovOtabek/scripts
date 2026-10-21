import { CBU_OWNED_FIELDS, mapCbuToCompanyInfo } from './cbu-map.util';
import { CbuCompanyData } from './cbu-api.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CBU_OWNED_FIELDS decides where stat.uz stands aside. If the mapper learns a
 * new column and the list does not, stat.uz starts competing for it — and the
 * symptom is not an error but a history timeline that fills with the two
 * sources rewriting each other's spelling of a name.
 */
describe('CBU_OWNED_FIELDS', () => {
  it('lists every column mapCbuToCompanyInfo can write', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'cbu-map.util.ts'),
      'utf8',
    );
    // Every `set('column', ...)` in the mapper.
    const written = new Set(
      [...source.matchAll(/\bset\('([a-z_]+)'/g)].map((m) => m[1]),
    );
    expect(written.size).toBeGreaterThan(10);

    const missing = [...written].filter((f) => !CBU_OWNED_FIELDS.has(f));
    expect(missing).toEqual([]);

    const stale = [...CBU_OWNED_FIELDS].filter((f) => !written.has(f));
    expect(stale).toEqual([]);
  });
});

describe('mapCbuToCompanyInfo — kfs_code', () => {
  const data = (kfs: unknown) =>
    ({ company: { name: 'ALFA', kfs } }) as unknown as CbuCompanyData;

  it('writes the form-of-ownership code as three-digit text', () => {
    expect(mapCbuToCompanyInfo(data(142)).kfs_code).toBe('142');
  });

  it('writes nothing for a missing or malformed code', () => {
    expect(mapCbuToCompanyInfo(data(null))).not.toHaveProperty('kfs_code');
    expect(mapCbuToCompanyInfo(data(14))).not.toHaveProperty('kfs_code');
  });
});
