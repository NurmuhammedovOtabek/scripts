import { load } from 'cheerio';

export interface FounderDto {
  name: string;
  share?: string;
}

export interface RegistrDto {
  inn: string | null;
  companyName: string | null;
  registerOrg: string | null;
  registerDate: string | null;
  registerNumber: string | null;
  legalForm: string | null;
  ifut: string | null;
  dbibt: string | null;
  smallBusiness: string | null;
  activityStatus: string | null;
  charterCapital: string | null;
  email: string | null;
  phone: string | null;
  mhobt: string | null;
  address: string | null;
  director: string | null;
  founders: FounderDto[];
  asOf: string | null;
}

const clean = (s: string) =>
  (s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const norm = (s: string) =>
  clean(s)
    .toLowerCase()
    .replace(/['\u0060\u00B4\u02BB\u02BC\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\s+/g, ' ');

function getByLabel(
  $: ReturnType<typeof load>,
  root: ReturnType<ReturnType<typeof load>>,
  labels: string[],
) {
  const tds = root.find('td').toArray();

  for (const want of labels) {
    const wantN = norm(want);

    for (const td of tds) {
      const txt = norm($(td).text());

      if (txt.includes(wantN)) {
        const valueTd = $(td).next('td');
        if (valueTd.length) return clean(valueTd.text());
      }
    }
  }

  return null;
}

export function parseRegistrHtml(html: string): RegistrDto {
  const $ = load(html);
  const root = $('#demo2');

  if (!root.length) throw new Error('demo2 topilmadi');

  const founders: FounderDto[] = [];

  root.find('tr').each((_, tr) => {
    const cols = $(tr)
      .find('td')
      .toArray()
      .map((td) => clean($(td).text()))
      .filter(Boolean);

    if (cols.length >= 1 && /^\d+\./.test(cols[0])) {
      founders.push({
        name: cols[0].replace(/^\d+\.\s*/, ''),
        share: cols[cols.length - 1] || undefined,
      });
    }
  });

  const asOf = clean(root.find('table').last().text()) || null;

  return {
    inn: getByLabel($, root, ['INN', '\u0418\u041D\u041D']),
    registerOrg: getByLabel($, root, [
      "Ro\u02BByxatdan o\u02BBtkazuvchi organ",
      '\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u0443\u044E\u0449\u0438\u0439 \u043E\u0440\u0433\u0430\u043D',
    ]),
    registerDate: getByLabel($, root, [
      "Davlat ro\u02BByxatidan o\u02BBtkazilgan sana",
      '\u0414\u0430\u0442\u0430 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438',
    ]),
    registerNumber: getByLabel($, root, [
      "Davlat ro\u02BByxatidan o\u02BBtkazilgan raqami",
      '\u041D\u043E\u043C\u0435\u0440 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438',
    ]),
    companyName: getByLabel($, root, [
      'Yuridik shaxsning nomi',
      '\u041D\u0430\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u044E\u0440\u0438\u0434\u0438\u0447\u0435\u0441\u043A\u043E\u0433\u043E \u043B\u0438\u0446\u0430',
    ]),
    legalForm: getByLabel($, root, ['Tashkiliy-huquqiy shakli', '\u041A\u043E\u0434 \u041E\u041F\u0424']),
    ifut: getByLabel($, root, ['IFUT', '\u041E\u041A\u042D\u0414']),
    dbibt: getByLabel($, root, ['DBIBT', '\u0421\u041E\u041E\u0413\u0423']),
    smallBusiness: getByLabel($, root, [
      'Kichik tadbirkorlik',
      '\u043C\u0430\u043B\u043E\u0433\u043E \u043F\u0440\u0435\u0434\u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430',
    ]),
    activityStatus: getByLabel($, root, [
      'Faollik holati',
      '\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438',
    ]),
    charterCapital: getByLabel($, root, ['Ustav fondi', '\u0423\u0441\u0442\u0430\u0432\u043D\u044B\u0439 \u0444\u043E\u043D\u0434']),
    email: getByLabel($, root, ['Elektron pochta', '\u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0439 \u043F\u043E\u0447\u0442\u044B']),
    phone: getByLabel($, root, [
      '\u041A\u043E\u043D\u0442\u0430\u043A\u0442\u043D\u044B\u0435 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u044B',
      '\u041A\u043E\u043D\u0442\u0430\u043A\u0442\u043D\u044B\u0439 \u0442\u0435\u043B\u0435\u0444\u043E\u043D',
      '\u0422\u0435\u043B\u0435\u0444\u043E\u043D',
      'Aloqa telefoni',
    ]),

    mhobt: getByLabel($, root, ['\u041A\u043E\u0434 \u0421\u041E\u0410\u0422\u041E', '\u0421\u041E\u0410\u0422\u041E', 'MHOBT', '\u041C\u0425\u041E\u0411\u0422']),

    address: getByLabel($, root, [
      '\u0423\u043B\u0438\u0446\u0430, \u0442\u0443\u043F\u0438\u043A, \u0434\u043E\u043C',
      '\u0423\u043B\u0438\u0446\u0430, \u0434\u043E\u043C',
      '\u0410\u0434\u0440\u0435\u0441',
      "Ko\u02BBcha, uy, xonadon",
    ]),

    director: getByLabel($, root, ['Rahbarning', '\u0440\u0443\u043A\u043E\u0432\u043E\u0434\u0438\u0442\u0435\u043B\u044F']),
    founders,
    asOf,
  };
}
