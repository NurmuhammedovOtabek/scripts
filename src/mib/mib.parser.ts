import { load } from 'cheerio';

// ─── DTOs ──────────────────────────────────────────────────────────────────

export interface MibHomeDto {
  /** "Qarzdorlikni tekshirish" sahifasiga yo'naltiruvchi link */
  debtCheckUrl: string | null;
  /** Token (agar mavjud bo'lsa) */
  token: string | null;
  /** Sahifadagi barcha linklar (debug uchun) */
  allLinks: { text: string; href: string }[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const clean = (s: string) =>
  (s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ─── Parser ────────────────────────────────────────────────────────────────

export function parseMibHome(
  html: string,
  baseUrl = 'https://mib.uz',
): MibHomeDto {
  const $ = load(html);

  // 1. Token olish (meta tag, input hidden, yoki boshqa joydan)
  let token: string | null = null;

  // Meta tag dan
  const metaCsrf = $('meta[name="csrf-token"]').attr('content');
  if (metaCsrf) {
    token = metaCsrf;
  }

  // Input hidden dan
  if (!token) {
    const inputToken = $('input[name="_token"]').val();
    if (inputToken) {
      token = String(inputToken);
    }
  }

  // 2. Barcha linklarni yig'ish
  const allLinks: { text: string; href: string }[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = clean($(el).text());
    const imgAlt = $(el).find('img').attr('alt') || '';
    allLinks.push({
      text: text || imgAlt,
      href,
    });
  });

  // 3. "Qarzdorlikni tekshirish" linkini topish
  let debtCheckUrl: string | null = null;

  // Kirill va lotin alifbosida qidirish
  const DEBT_KEYWORDS = [
    // Kirill
    'қарздорликни текшириш',
    'қарздорлик',
    'карздорликни текшириш',
    'карздорлик',
    // Lotin
    'qarzdorlikni tekshirish',
    'qarzdorlik',
    // Ijro hujjatlari
    'ижро ҳужжатлари',
    'ijro hujjatlari',
  ];

  $('a[href]').each((_, el) => {
    const text = clean($(el).text()).toLowerCase();
    const href = $(el).attr('href') || '';

    if (href === '#' || !href) return;

    for (const keyword of DEBT_KEYWORDS) {
      if (text.includes(keyword)) {
        debtCheckUrl = resolveUrl(href, baseUrl);
        return false; // break
      }
    }
  });

  return {
    debtCheckUrl,
    token,
    allLinks,
  };
}

// ─── URL resolver ──────────────────────────────────────────────────────────

function resolveUrl(href: string, baseUrl: string): string {
  // Agar "./..." bo'lsa, to'liq URL ga o'girish
  if (href.startsWith('./')) {
    return baseUrl.replace(/\/$/, '') + '/' + href.slice(2);
  }
  if (href.startsWith('/')) {
    const url = new URL(baseUrl);
    return url.origin + href;
  }
  if (href.startsWith('http')) {
    return href;
  }
  return baseUrl.replace(/\/$/, '') + '/' + href;
}
