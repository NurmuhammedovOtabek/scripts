import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import { parseRegistrHtml } from 'src/parser';

// ─── Cookie helpers ─────────────────────────────────────────────────────────

function mergeCookies(
  existing: Record<string, string>,
  setCookieHeader: string[] | undefined,
) {
  const out = { ...existing };
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [];
  for (const c of arr) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      out[name] = value;
    }
  }
  return out;
}

function cookiesToHeader(cookies: Record<string, string>) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class StatRegistryService {
  async getFromStatus(inn: string) {
    const client = axios.create({
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 20000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ru,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    let cookies: Record<string, string> = { smart_top: '1' };

    const root = await client.get('https://registr.stat.uz/');
    cookies = mergeCookies(cookies, root.headers['set-cookie']);
    const main = await client.get(
      'https://registr.stat.uz/registr/main.php?lang=ru',
      { headers: { Cookie: cookiesToHeader(cookies) } },
    );
    cookies = mergeCookies(cookies, main.headers['set-cookie']);

    const body = new URLSearchParams({
      OKPO: String(inn),
      lang: '0',
      submit: '',
    });

    const res = await client.post(
      'https://registr.stat.uz/registr/result/',
      body.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://registr.stat.uz',
          Referer: 'https://registr.stat.uz/registr/main.php?lang=ru',
          Cookie: cookiesToHeader(cookies),
        },
      },
    );

    if (res.status === 302) {
      throw new InternalServerErrorException(
        `Redirect 302 -> ${res.headers['location'] || 'no location'}`,
      );
    }

    const html = String(res.data || '');
    if (!html.includes('id="demo2"')) {
      throw new InternalServerErrorException(
        '200 received but demo2 not found in HTML.',
      );
    }
    return parseRegistrHtml(html);
  }
}
