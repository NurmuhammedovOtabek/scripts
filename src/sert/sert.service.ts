import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { load } from 'cheerio';

export interface CertificateFields {
  cert_body: string;
  blank_number: string;
  registry_number: string;
  issued_date: string;
  expiry_date: string;
  product_name: string;
  scheme: string;
  applicant_inn: string;
  tnved_code: string;
  applicant_name: string;
  country: string;
  status: string;
}

/**
 * Whether a scraped row is worth storing.
 *
 * A blank `registry_number` is normal — the registry leaves it empty on real
 * certificates, which still name the issuing body, the applicant, the product,
 * the country of origin and whether they are still valid. Those ARE kept; they
 * were previously discarded, which is what made the tab under-report.
 *
 * What is not kept is a row carrying no information at all. No such row has
 * been observed (0 of 4,828 checked across two companies), so this is a guard
 * against future junk rather than a filter on today's data. It must never be
 * widened into "this row looks thin" — certificates with no product or date
 * still identify a real, valid certificate, and dropping those is precisely
 * the bug this change exists to fix.
 */
export function hasStorableContent(cert: CertificateFields): boolean {
  if (cert.registry_number?.trim()) return true;
  return Boolean(
    cert.cert_body?.trim() ||
    cert.blank_number?.trim() ||
    cert.issued_date?.trim() ||
    cert.expiry_date?.trim() ||
    cert.product_name?.trim() ||
    cert.scheme?.trim() ||
    cert.tnved_code?.trim() ||
    cert.applicant_name?.trim() ||
    cert.country?.trim() ||
    cert.status?.trim(),
  );
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

@Injectable()
export class SertScriptService {
  private readonly logger = new Logger(SertScriptService.name);
  private readonly INDEX_URL = 'http://sert2.standart.uz/site/index';
  private readonly SEARCH_URL = 'http://sert2.standart.uz/site/register';

  /**
   * Get a fresh session cookie from the index page.
   * Returns "advanced-frontend=X; _csrf-frontend=Y" string.
   */
  async getSession(): Promise<string> {
    const resp = await axios.get(this.INDEX_URL, {
      headers: { 'User-Agent': UA },
      timeout: 15000,
      validateStatus: () => true,
    });

    const setCookies = (resp.headers['set-cookie'] as string[]) || [];
    const cookies = setCookies
      .map((raw) => raw.split(';')[0].trim())
      .filter(Boolean);

    if (cookies.length === 0) {
      throw new Error('sert2.standart.uz: no session cookies from index page');
    }

    return cookies.join('; ');
  }

  /**
   * Search certificates for one INN using an existing session.
   * If session is expired (302), refreshes automatically once.
   *
   * Returns updated { certs, session } so the caller can reuse the session.
   */
  async searchByInn(
    inn: string,
    session: string,
  ): Promise<{ certs: CertificateFields[]; session: string }> {
    let currentSession = session;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const resp = await axios.get(this.SEARCH_URL, {
        params: { 'Search[inn]': inn },
        headers: {
          'User-Agent': UA,
          Cookie: currentSession,
          Referer: this.INDEX_URL,
          Accept: 'text/html',
        },
        timeout: 30000,
        maxRedirects: 0, // 302 = session expired, handle manually
        validateStatus: (s) => s < 400 || s === 302,
      });

      if (resp.status === 302) {
        // Session expired — refresh and retry
        this.logger.debug(`[sert] session expired for INN=${inn}, refreshing`);
        currentSession = await this.getSession();
        continue;
      }

      return { certs: this.parse(resp.data), session: currentSession };
    }

    // Still getting 302 after refresh — return empty (will retry next cycle)
    return { certs: [], session: currentSession };
  }

  /**
   * Legacy single-call method for on-demand use (syncCompanyInfo).
   * Gets a fresh session per call — use searchByInn for bulk.
   */
  async getByInn(inn: string): Promise<CertificateFields[]> {
    try {
      const session = await this.getSession();
      const { certs } = await this.searchByInn(inn, session);
      this.logger.log(`sert2.standart.uz: INN=${inn} — ${certs.length} certs`);
      return certs;
    } catch (err: any) {
      this.logger.error(`sert2.standart.uz error INN=${inn}: ${err.message}`);
      return [];
    }
  }

  private parse(html: unknown): CertificateFields[] {
    const $ = load(String(html || ''));
    const data: CertificateFields[] = [];
    $('table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 14) {
        data.push({
          cert_body: $(tds[2]).text().trim(),
          blank_number: $(tds[3]).text().trim(),
          registry_number: $(tds[4]).text().trim(),
          issued_date: $(tds[5]).text().trim(),
          expiry_date: $(tds[6]).text().trim(),
          product_name: $(tds[7]).text().trim(),
          scheme: $(tds[8]).text().trim(),
          applicant_inn: $(tds[9]).text().trim(),
          tnved_code: $(tds[10]).text().trim(),
          applicant_name: $(tds[11]).text().trim(),
          country: $(tds[12]).text().trim(),
          status: $(tds[13]).text().trim(),
        });
      }
    });
    return data;
  }
}
