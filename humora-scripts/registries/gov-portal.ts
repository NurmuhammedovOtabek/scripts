import { RegistryHttp } from './registry-http';
import { dayOf, textOf } from './registry-normalize';

/**
 * gov.uz, the ministries' common site. A register published as a file is a
 * document in one of an authority's sections; a new edition is the same
 * document with a new file. The site is a single-page app over one API:
 *
 *   GET https://api-portal.gov.uz/authorities/lists/sections?code_name=<section>&page=<n>
 *   headers  code: <authority>  language: oz
 *   → { data: [{ id, title, link, body, … }], total_page, current_page }
 *
 * `link` is the document's file when it has one; some documents put their
 * files in `body` instead (HTML with links). Files sit under
 * `/uploads/<org>/<yyyy>/<mm>/<dd>/…`, which dates them. The portal serves
 * PDFs to scripts and refuses `.xlsx` (nginx 403 even for a file that does
 * not exist), so a register published only as XLSX cannot be read here.
 */
export const GOV_API = 'https://api-portal.gov.uz';

export interface GovDocument {
  id: number;
  title: string;
  /** Every PDF the document offers: its link and those in its body. */
  pdfs: string[];
  /** Every other file it offers (XLSX and the like). */
  others: string[];
}

const FILE = /https?:\/\/[^\s"'<>]+\.(pdf|xlsx?|docx?)/gi;

/** Every document of a section, every page of it. */
export async function govSection(
  http: RegistryHttp,
  authority: string,
  section: string,
): Promise<GovDocument[]> {
  const docs: GovDocument[] = [];
  for (let page = 1; page <= 20; page++) {
    const resp = await http.get(`${GOV_API}/authorities/lists/sections`, {
      params: { code_name: section, page },
      headers: { Accept: 'application/json', code: authority, language: 'oz' },
    });
    const body = resp.data;
    if (!body || !Array.isArray(body.data)) {
      throw new Error(
        `gov.uz section ${authority}/${section} came without a list`,
      );
    }
    for (const item of body.data) {
      const files = [
        ...(typeof item.link === 'string' ? [item.link] : []),
        ...String(item.body ?? '').matchAll(FILE),
      ].map((f) => (typeof f === 'string' ? f : f[0]).trim());
      docs.push({
        id: Number(item.id),
        title: textOf(item.title) ?? '',
        pdfs: [...new Set(files.filter((f) => /\.pdf$/i.test(f)))],
        others: [...new Set(files.filter((f) => !/\.pdf$/i.test(f)))],
      });
    }
    const pages = Number(body.total_page) || 1;
    if (page >= pages) break;
  }
  return docs;
}

/** The day a file was uploaded, from its path (`/uploads/3/2026/02/09/…`). */
export function uploadDay(url: string): string | null {
  const m = /\/uploads\/\d+\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(url);
  return m ? dayOf(`${m[1]}-${m[2]}-${m[3]}`) : null;
}

/** The newest of some files, by upload day (files without one last). */
export function newestFile(urls: string[]): string | null {
  return (
    [...urls].sort((a, b) =>
      (uploadDay(b) ?? '').localeCompare(uploadDay(a) ?? ''),
    )[0] ?? null
  );
}

/** A PDF, or an error: the portal answers some refusals with an HTML page. */
export async function downloadPdf(
  http: RegistryHttp,
  url: string,
): Promise<Buffer> {
  const resp = await http.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    headers: { Referer: 'https://gov.uz/' },
  });
  const buf = Buffer.from(resp.data);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`${url} is not a PDF`);
  }
  return buf;
}

const MONTHS: Record<string, number> = {
  yanvar: 1,
  январ: 1,
  fevral: 2,
  феврал: 2,
  mart: 3,
  март: 3,
  aprel: 4,
  апрел: 4,
  may: 5,
  май: 5,
  iyun: 6,
  июн: 6,
  iyul: 7,
  июл: 7,
  avgust: 8,
  август: 8,
  sentabr: 9,
  sentyabr: 9,
  сентябр: 9,
  oktabr: 10,
  oktyabr: 10,
  октябр: 10,
  noyabr: 11,
  ноябр: 11,
  dekabr: 12,
  декабр: 12,
};

/**
 * The "as of" day a register prints in its title: "2025-yil 31-dekabr
 * holatiga", "2026 йил 31 июль ҳолатига", "31.07.2026 holatiga". Null when
 * it prints none.
 */
export function editionDayOf(text: string): string | null {
  const word =
    /(20\d{2})\s*[-–]?\s*(?:yil|йил)\w*\s*(\d{1,2})\s*[-–]?\s*([a-zа-яўқғҳ]+)\s*(?:holat|ҳолат|holat)/iu.exec(
      text,
    );
  if (word) {
    const stem = Object.keys(MONTHS).find((k) =>
      word[3].toLowerCase().startsWith(k),
    );
    if (stem) {
      const mm = String(MONTHS[stem]).padStart(2, '0');
      return dayOf(`${word[1]}-${mm}-${word[2].padStart(2, '0')}`);
    }
  }
  const dotted =
    /(\d{1,2}\.\d{1,2}\.20\d{2})\s*(?:yil\s*)?(?:holat|ҳолат)/iu.exec(text);
  return dotted ? dayOf(dotted[1]) : null;
}
