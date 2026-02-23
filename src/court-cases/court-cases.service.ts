import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

@Injectable()
export class CourtCasesService {
  async getCourtCases(tin?: string, caseNumber?: string) {
    if (!tin && !caseNumber) {
      throw new InternalServerErrorException(
        'Provide either ?tin= or ?case= parameter',
      );
    }

    const findBy = tin ? 'findByTin' : 'findByNumber';
    const input = tin || caseNumber!.replace(/\//g, '@');

    const courtTypes = ['ECONOMIC', 'CIVIL', 'CRIMINAL', 'ADMINISTRATIVE'];
    const urls = [
      `https://jadval.sud.uz/case/${findBy}/${encodeURIComponent(input)}`,
      ...courtTypes.map(
        (type) =>
          `https://jadvalapi.sud.uz/online-monitoring/${type}/${findBy}/${encodeURIComponent(input)}`,
      ),
    ];

    const results: any[] = [];
    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
      Origin: 'https://my.sud.uz',
      Referer: 'https://my.sud.uz/',
    };

    await Promise.all(
      urls.map(async (url) => {
        try {
          const resp = await axios.get(url, { timeout: 15_000, headers });
          const data = resp.data;
          if (Array.isArray(data) && data.length > 0) {
            results.push(...data);
          }
        } catch {
          // Individual court API failures are non-fatal
        }
      }),
    );

    if (results.length === 0) {
      return {
        message: 'Ишлар топилмади (No court cases found)',
        tin,
        caseNumber,
      };
    }
    return results;
  }
}
