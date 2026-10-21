import type { RegistryHttp } from './registry-http';

/** A label in the three languages the site speaks. */
export interface Labels {
  uz: string;
  ru: string;
  en: string;
}

/** What field of life the register covers; the page groups by it. */
export type RegistrySector =
  | 'finance'
  | 'capital_market'
  | 'professional'
  | 'customs'
  | 'tax'
  | 'pharma'
  | 'ngo'
  | 'tourism'
  | 'it'
  | 'energy'
  | 'telecom'
  | 'media'
  | 'education'
  | 'transport'
  | 'investment';

/** What an entry of the register is. */
export type RegistryKind =
  | 'licence'
  | 'certificate'
  | 'registration'
  | 'membership'
  | 'benefit'
  | 'audit'
  | 'project'
  | 'permit'
  | 'status';

/**
 * How often the register is read: `daily` in the 03:10 night run (Monday to
 * Saturday) and the Sunday chain, `weekly` in the Sunday chain only, `monthly`
 * on the first Sunday of the month, `manual` only from a file an admin posts.
 */
export type RegistryCadence = 'daily' | 'weekly' | 'monthly' | 'manual';

export interface RegistryMeta {
  /** `registry_sources.code` — neutral, partners see it; where the register
   *  is published is its `source` (`REGISTRY_PUBLIC_PAGES`). */
  code: string;
  sector: RegistrySector;
  kind: RegistryKind;
  /** What the register is ("Mikromoliya tashkiloti litsenziyasi"). */
  title: Labels;
  cadence: RegistryCadence;
  /** Shown on the company page and the partner API. */
  display: boolean;
  /**
   * The register carries no STIR: rows go to `registry_name_rows` and are tied
   * to a company only when exactly one company has the same name.
   */
  nameOnly?: boolean;
  /**
   * Entries are one period's figures (benefits), not a standing licence: the
   * page shows the period, never "no longer listed".
   */
  periodic?: boolean;
  /** Labels of the keys of `fields`, in the order the page shows them. */
  fieldLabels: Record<string, Labels>;
  /** A complete read with fewer rows than this is cut off: nothing written. */
  minRows: number;
}

/** One entry of a register, read into our columns. */
export interface MappedEntry {
  /** Stable within the source: licence number, certificate number, row id. */
  sourceKey: string;
  /** Nine-digit STIR, or null. */
  inn: string | null;
  /** Fourteen-digit PINFL of a person (benefit lists), or null. Never logged. */
  pinfl: string | null;
  /** The taxpayer number as the source wrote it, when it is not a STIR. */
  rawTin: string | null;
  name: string | null;
  number: string | null;
  status: string | null;
  /** Null when the source does not say. */
  isActive: boolean | null;
  validFrom: string | null;
  validTo: string | null;
  amount: number | null;
  amountUnit: string | null;
  /** What the page shows, under the keys of `fieldLabels`. No personal data. */
  fields: Record<string, unknown>;
  /** The source row, personal data removed. */
  raw: Record<string, unknown>;
  /** The edition or period end the entry belongs to, when known. */
  asOf: string | null;
  /** Name-only registers: the region the row names, to narrow the match. */
  region?: string | null;
}

/** A row left out, and why — counted in the report. */
export interface Skip {
  skip: string;
}

export type MapResult = MappedEntry | Skip;

export function isSkip(r: MapResult): r is Skip {
  return (r as Skip).skip !== undefined;
}

export interface FetchResult {
  rows: unknown[];
  /**
   * The source answered in full. A read cut by the trial limit, the request
   * budget or a missing page is not: nothing is written as removed then.
   */
  complete: boolean;
  /** How many rows the source says it holds, when it says. */
  expected: number | null;
  /** The register's own "as of" date, when it states one. */
  editionDate?: string | null;
  /** The period the figures cover ("2026Q1"), periodic registers only. */
  period?: string | null;
  /**
   * Periods this read left alone — their file has not changed since it was
   * read (see `state`). Their entries stay as they are: never delisted by
   * this read, and counted towards `minRows`.
   */
  heldPeriods?: string[];
  /** What the adapter keeps for its next read (saved when this one is written). */
  state?: unknown;
  /** Lines for the run's report: a file that could not be read, and why. */
  notes?: string[];
  /** The source files this read was made from, kept in the registers' bucket. */
  files?: Array<{ url: string; day: string | null; data: Buffer }>;
}

/** What the mapper knows about the read it maps. */
export interface MapContext {
  editionDate: string | null;
  period: string | null;
  /** Today in Tashkent, `YYYY-MM-DD`. */
  today: string;
}

export interface FetchOptions {
  /** Trial mode: stop after this many requests (the read is not complete). */
  limit?: number;
  /**
   * The `state` of the last written read (`registry_sources.adapter_state`);
   * none on a trial or when a re-read is asked for.
   */
  state?: unknown;
}

export interface RegistryAdapter {
  meta: RegistryMeta;
  /** The whole register, or throws. */
  fetchAll(http: RegistryHttp, opts: FetchOptions): Promise<FetchResult>;
  /** One source row → one entry, or a reason to leave it out. */
  map(row: unknown, ctx: MapContext): MapResult;
}
