import { createHash } from 'crypto';
import { GXP_API } from './adapters/pharma.adapters';

/**
 * Where the registers' documents are kept: one bucket, each register under a
 * folder of its own code — the certificates the GxP register serves as PDF
 * (`pharma_gpp/…`), and every source file a register is read from
 * (`audit_firm/_source/…`), kept as it was read.
 */
export function registryBucket(): string {
  return process.env.MINIO_REGISTRIES_BUCKET || 'registry-documents';
}

/** Key prefix, so a test environment writes into a folder it can drop later. */
function registryPrefix(): string {
  const p = process.env.MINIO_REGISTRIES_PREFIX || '';
  return p && !p.endsWith('/') ? `${p}/` : p;
}

const hashOf = (url: string) =>
  createHash('sha1').update(url).digest('hex').slice(0, 12);

/**
 * Registers whose entries have a certificate PDF at the source, by our code,
 * with the GxP type the download asks for. GMP's numbers are refused there
 * (404, 2026-10-15), so GMP has none.
 */
const GXP_DOCUMENT_TYPE: Record<string, string> = {
  pharma_gpp: 'GPP',
  pharma_gdp: 'GDP',
};

export const DOCUMENT_REGISTERS = Object.keys(GXP_DOCUMENT_TYPE);

/** The address of an entry's certificate at the source, or null when it has none. */
export function documentUrl(
  source: string,
  raw: Record<string, unknown> | null,
): string | null {
  const type = GXP_DOCUMENT_TYPE[source];
  const number = raw?.certificate_number;
  if (!type || typeof number !== 'string' || !number.trim()) return null;
  // The number exactly as the register writes it: some begin with a space,
  // and trimmed they are a 404.
  return `${GXP_API}/certificate/download/${encodeURIComponent(number)}?gxpType=${type}`;
}

/**
 * `pharma_gpp/GPP_-_6336_2025-3f2a9c01b7d4.pdf` — the register's folder, the
 * certificate's number, the source address hashed: a file published under a
 * new address is a new object, and the one before it stays.
 */
export function documentKey(
  source: string,
  number: string,
  url: string,
): string {
  const name = number.trim().replace(/[^\w.-]+/g, '_') || 'document';
  return `${registryPrefix()}${source}/${name}-${hashOf(url)}.pdf`;
}

/** A register's source file as read: `audit_firm/_source/2026-02-09-3f2a9c01b7d4.pdf`. */
export function sourceFileKey(
  source: string,
  url: string,
  day: string | null,
): string {
  return `${registryPrefix()}${source}/_source/${day ?? 'undated'}-${hashOf(url)}.pdf`;
}
