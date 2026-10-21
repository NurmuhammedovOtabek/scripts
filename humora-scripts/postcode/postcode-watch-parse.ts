import { createHash } from 'crypto';

/** One UzPost post office as the weekly check keeps it. */
export interface WatchedOffice {
  postcode: string;
  name: string | null;
  region: string | null;
  district: string | null;
  /** The mahalla the office stands in, as UzPost writes it. */
  mfy: string | null;
  lat: number | null;
  lng: number | null;
  /** Hash of the service area; null when UzPost draws none. */
  areaHash: string | null;
}

const CODE6 = /^\d{6}$/;

const sha1 = (value: unknown) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex');

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s !== 'null' ? s : null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? n : null;
};

/**
 * `new.pochta.uz/api/v1/maps/post/offices/` — `{ result: [{ postal_office,
 * locations: { locations: [[lat, lng], …] } }] }`. Offices without a
 * six-digit index are left out.
 */
export function parseUzpostOffices(body: unknown): WatchedOffice[] {
  const list = (body as any)?.result;
  if (!Array.isArray(list)) throw new Error('UzPost answered without a list');
  const out: WatchedOffice[] = [];
  for (const row of list) {
    const po = row?.postal_office ?? {};
    const postcode = text(po.index);
    if (!postcode || !CODE6.test(postcode)) continue;
    const ring = row?.locations?.locations;
    out.push({
      postcode,
      name: text(po.name_uz) ?? text(po.name_ru),
      region: text(po.region),
      district: text(po.district),
      mfy: text(po.mfy),
      lat: num(po.lat),
      lng: num(po.lng),
      areaHash: Array.isArray(ring) && ring.length ? sha1(ring) : null,
    });
  }
  return out;
}

/**
 * `emu.uz/data/indeks-hududlar.json` — `{ features: [{ i, g }] }`, several
 * features per index at times; one hash per index over all of its polygons.
 */
export function parseEmuZones(body: unknown): Map<string, string> {
  const features = (body as any)?.features;
  if (!Array.isArray(features)) throw new Error('EMU answered without zones');
  const byCode = new Map<string, string[]>();
  for (const f of features) {
    const code = String(f?.i ?? '').trim();
    if (!CODE6.test(code) || !f?.g) continue;
    const list = byCode.get(code) ?? [];
    list.push(JSON.stringify(f.g));
    byCode.set(code, list);
  }
  return new Map(
    [...byCode.entries()].map(([code, geoms]) => [code, sha1(geoms.sort())]),
  );
}

export interface KeyedDiff {
  added: string[];
  gone: string[];
  changed: string[];
  unchanged: number;
}

/** What changed between two `key → hash` maps; `gone` only counts the held. */
export function diffKeyed(
  held: Map<string, string | null>,
  fresh: Map<string, string | null>,
): KeyedDiff {
  const out: KeyedDiff = { added: [], gone: [], changed: [], unchanged: 0 };
  for (const [key, hash] of fresh) {
    if (!held.has(key)) out.added.push(key);
    else if ((held.get(key) ?? null) !== hash) out.changed.push(key);
    else out.unchanged++;
  }
  for (const key of held.keys()) if (!fresh.has(key)) out.gone.push(key);
  return out;
}
