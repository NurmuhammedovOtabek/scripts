import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as Tesseract from 'tesseract.js';
import { Jimp } from 'jimp';
import { parseMibHome, MibHomeDto } from './mib.parser';
import {
  parseDebtCheckPage,
  parseDebtResult,
  MibDebtFormDto,
  MibDebtResultDto,
} from './mib-debt.parser';
import { solveMathCaptcha } from './mib-captcha.solver';
import { cropFrame, readOperator } from './mib-captcha.image';

@Injectable()
export class MibScriptService {
  private readonly logger = new Logger(MibScriptService.name);
  private readonly BASE_URL = 'https://mib.uz';

  private session = {
    cookies: '',
    token: '',
  };

  /** Oxirgi yuklangan debt sahifasi URL (relative URL lar uchun base) */
  private lastDebtPageUrl = '';

  private readonly defaultHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  // Tesseract worker (qayta ishlatish uchun)
  private worker: Tesseract.Worker | null = null;

  constructor(
    private readonly httpService: HttpService,
  ) {}


  /** "1 234 567,89 so'm" → 1234567.89, and anything unreadable → null. */
  private parseAmount(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const cleaned = String(raw)
      .replace(/[^\d.,]/g, '')
      .replace(',', '.');
    return parseFloat(cleaned) || null;
  }

  // ============= ASOSIY ENDPOINT =============

  /**
   * STIR bo'yicha qarzdorlikni tekshirish (to'liq oqim)
   */
  async checkDebtByInn(inn: string): Promise<MibDebtResultDto> {
    return this.checkDebt(inn, 'inn');
  }

  /**
   * Enforcement debts against a person, by PINFL.
   *
   * mib.uz shows four tabs on the same page — search, passport, ЖШШИР and
   * STIR — as four separate forms, each carrying its own Wicket hidden token.
   * Only the STIR one was ever submitted, which is why an individual's debts
   * were unreachable: the ЖШШИР form posts `pinfl` and a different token, so
   * reusing the STIR form's fields would have been rejected.
   */
  async checkDebtByPinfl(pinfl: string): Promise<MibDebtResultDto> {
    return this.checkDebt(pinfl, 'pinfl');
  }

  private async checkDebt(
    inn: string,
    key: 'inn' | 'pinfl',
  ): Promise<MibDebtResultDto> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.logger.log(
        `=== Urinish ${attempt}/${MAX_ATTEMPTS}, INN: ${inn} ===`,
      );

      try {
        // 1. Home sahifa -> qarzdorlik linki
        const homeData = await this.fetchHome();
        if (!homeData.debtCheckUrl) {
          return {
            success: false,
            error: 'Qarzdorlik linki topilmadi',
            summary: null,
            debts: [],
          };
        }

        // 2. Qarzdorlik sahifasini yuklash
        const debtPageHtml = await this.fetchPage(homeData.debtCheckUrl);

        // 3. Form ma'lumotlarini olish
        const formData = parseDebtCheckPage(
          debtPageHtml,
          this.lastDebtPageUrl,
          key,
        );
        if (!formData) {
          return {
            success: false,
            error: 'STIR formasi topilmadi',
            summary: null,
            debts: [],
          };
        }
        this.logger.log(
          `Form topildi: ${formData.formId}, captcha: ${formData.captchaImgUrl ? 'bor' : "yo'q"}`,
        );

        // 4. Captcha yechish
        const captchaAnswer = await this.solveCaptcha(formData.captchaImgUrl);
        if (captchaAnswer === null) {
          this.logger.warn(`Captcha yechilmadi, qayta urinish...`);
          continue;
        }
        this.logger.log(`Captcha javob: ${captchaAnswer}`);

        // 5. Form yuborish
        const resultHtml = await this.submitDebtForm(
          formData,
          inn,
          String(captchaAnswer),
        );

        // 6. Natijani parse qilish
        const result = parseDebtResult(resultHtml);

        // A rejected captcha is worth another attempt, not a failure.
        if (
          !result.success &&
          result.error &&
          /captcha|код|himoya|tekshiruv/i.test(result.error)
        ) {
          this.logger.warn(`captcha rejected: ${result.error} — retrying`);
          continue;
        }


        return result;
      } catch (error) {
        this.logger.error(`attempt ${attempt} failed: ${error.message}`);
        if (attempt === MAX_ATTEMPTS) throw error;
      }
    }

    return {
      success: false,
      error: `${MAX_ATTEMPTS} urinishdan keyin muvaffaqiyatsiz`,
      summary: null,
      debts: [],
    };
  }

  // ============= CAPTCHA =============

  private async getWorker(): Promise<Tesseract.Worker> {
    if (!this.worker) {
      // Uzbek Cyrillic, not Russian.
      //
      // The captcha is written in Uzbek — `ўн`, `тўққиз`, `тўрт` — and `ў қ ғ
      // ҳ` do not exist in the Russian alphabet, so the Russian model can only
      // approximate them: `тўққиз` came back as `туккиз`. The Uzbek model
      // reads them as written. Russian remains the fallback because the model
      // is fetched at first use and a download failure should degrade rather
      // than take the source down.
      try {
        this.worker = await Tesseract.createWorker('uzb_cyrl');
      } catch (err: any) {
        this.logger.warn(
          `[captcha] uzb_cyrl model unavailable (${err.message}) — falling back to rus`,
        );
        this.worker = await Tesseract.createWorker('rus');
      }
      await this.worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      });
    }
    return this.worker;
  }

  /**
   * Captcha rasmini yuklash, OCR qilish va matematik javob olish
   */
  private async solveCaptcha(captchaImgUrl: string): Promise<number | null> {
    if (!captchaImgUrl) return null;

    try {
      this.logger.log(
        `Captcha rasmi yuklanmoqda: ${captchaImgUrl.substring(0, 80)}...`,
      );

      // Rasmni yuklash
      const response = await firstValueFrom(
        this.httpService.get(captchaImgUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': this.defaultHeaders['User-Agent'],
            Accept: 'image/*,*/*',
            Referer: this.lastDebtPageUrl || `${this.BASE_URL}/home`,
            Cookie: this.session.cookies,
          },
        }),
      );

      this.saveCookies(response.headers['set-cookie']);
      const imageBuffer = Buffer.from(response.data);
      this.logger.log(`Captcha rasmi yuklandi: ${imageBuffer.length} bayt`);

      // The operation is measured off the image, not recognised. OCR drops
      // this character or reports `+` as `-`, and a wrong sign is submitted
      // with confidence — worse than reading nothing at all.
      const operator = await readOperator(imageBuffer);
      this.logger.debug(`[captcha] amal belgisi: ${operator ?? 'aniqlanmadi'}`);

      // Try each preprocessing strategy.
      const strategies = await this.preprocessCaptcha(imageBuffer);

      const worker = await this.getWorker();

      const ocrResults: { name: string; text: string }[] = [];

      for (const { name, buffer } of strategies) {
        const { data } = await worker.recognize(buffer);
        const rawText = data.text.trim();
        // Per-strategy result is debug — only the final outcome matters.
        this.logger.debug(`[captcha] OCR [${name}]: "${rawText}"`);
        ocrResults.push({ name, text: rawText });

        const answer = solveMathCaptcha(rawText, operator);
        if (answer !== null) {
          this.logger.log(
            `[captcha] solved by strategy=${name}: "${rawText}" ${operator ?? '?'} = ${answer}`,
          );
          return answer;
        }
      }

      // All strategies failed — log all OCR outputs at warn so we can debug.
      this.logger.warn(
        `[captcha] all ${strategies.length} strategies failed; outputs=${JSON.stringify(ocrResults)}`,
      );
      return null;
    } catch (error) {
      this.logger.error(`[captcha] error: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Turli preprocessing strategiyalar bilan rasmni tayyorlash
   */
  private async preprocessCaptcha(
    imageBuffer: Buffer,
  ): Promise<{ name: string; buffer: Buffer }[]> {
    const results: { name: string; buffer: Buffer }[] = [];

    // Every strategy works from the frameless image.
    //
    // This one change did more than all five strategies put together. The
    // captcha is drawn inside a 2px rectangle, and a closed box around the
    // whole image gives the line segmenter something to interpret: of the
    // first three captchas collected, two came back as an empty string under
    // every strategy and every page-segmentation mode. Cropped, all three
    // read.
    let src = imageBuffer;
    try {
      const framed = await Jimp.read(src);
      src = await cropFrame(framed).getBuffer('image/png');
    } catch (e) {
      this.logger.warn(`[captcha] ramkani kesib bo'lmadi: ${e.message}`);
    }

    // Strategy 1: Faqat kattalashtirish (raw + resize)
    try {
      const img = await Jimp.read(src);
      img.resize({ w: 600, h: 120 });
      const buf = await img.getBuffer('image/png');
      results.push({ name: 'resize-only', buffer: buf });
    } catch (e) {
      this.logger.warn(`strategy 1 failed: ${e.message}`);
    }

    // Strategy 2: Greyscale + yumshoq kontrast + katta resize
    try {
      const img = await Jimp.read(src);
      img.greyscale();
      img.contrast(0.3);
      img.resize({ w: 600, h: 120 });
      const buf = await img.getBuffer('image/png');
      results.push({ name: 'grey-soft-contrast', buffer: buf });
    } catch (e) {
      this.logger.warn(`strategy 2 failed: ${e.message}`);
    }

    // Strategy 3: Greyscale + kuchli kontrast + threshold + katta resize
    try {
      const img = await Jimp.read(src);
      img.greyscale();
      img.contrast(0.8);
      img.threshold({ max: 180 });
      img.resize({ w: 600, h: 120 });
      const buf = await img.getBuffer('image/png');
      results.push({ name: 'grey-strong-threshold', buffer: buf });
    } catch (e) {
      this.logger.warn(`strategy 3 failed: ${e.message}`);
    }

    // Strategy 4: Invert (oq matn qora fonda bo'lishi mumkin)
    try {
      const img = await Jimp.read(src);
      img.greyscale();
      img.invert();
      img.contrast(0.5);
      img.threshold({ max: 160 });
      img.resize({ w: 600, h: 120 });
      const buf = await img.getBuffer('image/png');
      results.push({ name: 'invert', buffer: buf });
    } catch (e) {
      this.logger.warn(`strategy 4 failed: ${e.message}`);
    }

    // Strategy 5: Raw (hech narsa qilmasdan)
    results.push({ name: 'raw', buffer: imageBuffer });

    return results;
  }

  // ============= FORM YUBORISH =============

  /**
   * Wicket AJAX form submit
   */
  private async submitDebtForm(
    form: MibDebtFormDto,
    inn: string,
    secureCode: string,
  ): Promise<string> {
    const submitUrl = form.ajaxSubmitUrl || form.formAction;
    this.logger.log(`Form yuborilmoqda: INN=${inn}, code=${secureCode}`);
    this.logger.log(`Submit URL: ${submitUrl.substring(0, 80)}...`);

    // Wicket form data
    const formData = new URLSearchParams();
    formData.append(form.hiddenFieldName, form.hiddenFieldValue);
    formData.append(form.keyFieldName, inn);
    formData.append('secure_code', secureCode);
    formData.append('submit_button', '1');

    const isAjax = form.ajaxSubmitUrl && form.ajaxSubmitUrl !== form.formAction;

    const headers: Record<string, string> = {
      'User-Agent': this.defaultHeaders['User-Agent'],
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: isAjax ? 'application/xml, text/xml, */*' : 'text/html,*/*',
      Referer: this.lastDebtPageUrl || `${this.BASE_URL}/home`,
      Cookie: this.session.cookies,
      Origin: this.BASE_URL,
      Connection: 'keep-alive',
    };

    if (isAjax) {
      headers['Wicket-Ajax'] = 'true';
      headers['Wicket-Ajax-BaseURL'] = '.';
      headers['Wicket-FocusedElementId'] = 'id6c';
    }

    const response = await firstValueFrom(
      this.httpService.post(submitUrl, formData.toString(), {
        headers,
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
      }),
    );

    this.saveCookies(response.headers['set-cookie']);

    const responseText = String(response.data || '');
    this.logger.log(
      `Form javob: status=${response.status}, hajm=${responseText.length} belgi`,
    );

    // Wicket AJAX javob — XML ichida redirect URL bo'lishi mumkin
    // <ajax-response><redirect><![CDATA[...]]></redirect></ajax-response>
    const redirectMatch = responseText.match(
      /<redirect><!\[CDATA\[([^\]]+)\]\]>/,
    );
    if (redirectMatch) {
      let redirectUrl = redirectMatch[1];
      if (!redirectUrl.startsWith('http')) {
        redirectUrl = `${this.BASE_URL}/${redirectUrl.replace(/^\.\//, '')}`;
      }
      redirectUrl = this.cleanUrl(redirectUrl);
      this.logger.log(
        `Wicket AJAX redirect: ${redirectUrl.substring(0, 80)}...`,
      );

      // Redirect sahifasini yuklash
      return await this.fetchPage(redirectUrl);
    }

    // HTTP 302 redirect
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'];
      if (location) {
        const redirectUrl = location.startsWith('http')
          ? location
          : `${this.BASE_URL}${location.startsWith('/') ? '' : '/'}${location}`;
        this.logger.log(`HTTP redirect: ${redirectUrl.substring(0, 80)}...`);
        return await this.fetchPage(this.cleanUrl(redirectUrl));
      }
    }

    return responseText;
  }

  // ============= SESSIYA FUNKSIYALARI =============

  /** Cookie larni response dan olish va saqlash */
  private saveCookies(setCookieHeader: string[] | undefined) {
    if (!setCookieHeader) return;
    const newPairs = setCookieHeader.map((c) => c.split(';')[0]);

    const cookieMap = new Map<string, string>();
    if (this.session.cookies) {
      this.session.cookies.split('; ').forEach((pair) => {
        const [key] = pair.split('=');
        if (key) cookieMap.set(key, pair);
      });
    }
    newPairs.forEach((pair) => {
      const [key] = pair.split('=');
      if (key) cookieMap.set(key, pair);
    });

    this.session.cookies = Array.from(cookieMap.values()).join('; ');
  }

  /** URL dan ;jsessionid=... ni olib tashlash */
  private cleanUrl(url: string): string {
    return url.replace(/;jsessionid=[^?&/]*/gi, '');
  }

  /**
   * mib.uz/home sahifasini ochib, "Qarzdorlikni tekshirish" linkini olish
   */
  async fetchHome(): Promise<MibHomeDto> {
    try {
      this.logger.log('mib.uz/home sahifasi yuklanmoqda...');

      const response = await firstValueFrom(
        this.httpService.get(`${this.BASE_URL}/home`, {
          headers: {
            ...this.defaultHeaders,
            ...(this.session.cookies && { Cookie: this.session.cookies }),
          },
          maxRedirects: 10,
        }),
      );

      this.saveCookies(response.headers['set-cookie']);

      const html = String(response.data || '');
      const parsed = parseMibHome(html, this.BASE_URL);

      if (parsed.debtCheckUrl) {
        parsed.debtCheckUrl = this.cleanUrl(parsed.debtCheckUrl);
        this.logger.log(
          `Qarzdorlik linki: ${parsed.debtCheckUrl.substring(0, 80)}...`,
        );
      } else {
        this.logger.warn('Qarzdorlik linki topilmadi!');
      }

      return parsed;
    } catch (error) {
      this.logger.error(`mib.uz/home failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sahifani yuklash (redirect larni qo'lda boshqarish)
   */
  async fetchPage(url: string): Promise<string> {
    const cleanedUrl = this.cleanUrl(url);
    this.logger.log(`Sahifa yuklanmoqda: ${cleanedUrl.substring(0, 80)}...`);

    let currentUrl = cleanedUrl;
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      attempts++;

      const response = await firstValueFrom(
        this.httpService.get(currentUrl, {
          headers: {
            ...this.defaultHeaders,
            Referer: `${this.BASE_URL}/home`,
            Cookie: this.session.cookies,
          },
          maxRedirects: 0,
          validateStatus: (status) => status < 400,
        }),
      );

      this.saveCookies(response.headers['set-cookie']);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers['location'];
        if (location) {
          currentUrl = location.startsWith('http')
            ? location
            : `${this.BASE_URL}${location.startsWith('/') ? '' : '/'}${location}`;
          currentUrl = this.cleanUrl(currentUrl);
          this.logger.log(
            `Redirect (${response.status}): ${currentUrl.substring(0, 60)}...`,
          );
          continue;
        }
      }

      const html = String(response.data || '');

      const metaRefresh = html.match(/content="[^"]*URL=([^"]+)"/i);
      if (metaRefresh) {
        const redirectUrl = metaRefresh[1];
        currentUrl = redirectUrl.startsWith('http')
          ? redirectUrl
          : `${this.BASE_URL}${redirectUrl.startsWith('/') ? '' : '/'}${redirectUrl}`;
        currentUrl = this.cleanUrl(currentUrl);
        this.logger.log(
          `Meta refresh redirect: ${currentUrl.substring(0, 60)}...`,
        );
        continue;
      }

      this.lastDebtPageUrl = currentUrl;
      this.logger.log(`Sahifa yuklandi, hajmi: ${html.length} belgi`);
      return html;
    }

    throw new Error(`${maxAttempts} ta redirect dan keyin sahifa yuklanmadi`);
  }

  /**
   * To'liq oqim: home -> link topish -> sahifa yuklash (debug uchun)
   */
  async getDebtCheckInfo(): Promise<{
    homeData: MibHomeDto;
    debtPageHtml?: string;
  }> {
    const homeData = await this.fetchHome();

    if (homeData.debtCheckUrl) {
      const debtPageHtml = await this.fetchPage(homeData.debtCheckUrl);
      return { homeData, debtPageHtml };
    }

    return { homeData };
  }

  /**
   * Debug: captcha rasmini yuklash va OCR natijasini ko'rsatish
   */
  async testCaptchaSolving() {
    // 1. Home -> debt page -> form
    const homeData = await this.fetchHome();
    if (!homeData.debtCheckUrl) {
      return { success: false, error: 'Qarzdorlik linki topilmadi' };
    }

    const debtPageHtml = await this.fetchPage(homeData.debtCheckUrl);
    const formData = parseDebtCheckPage(debtPageHtml, this.lastDebtPageUrl);
    if (!formData || !formData.captchaImgUrl) {
      return { success: false, error: 'Captcha rasmi topilmadi' };
    }

    // 2. Captcha yechish
    const answer = await this.solveCaptcha(formData.captchaImgUrl);

    // Debug: barcha OCR natijalarini ko'rsatish
    const ocrResults: { name: string; text: string }[] = [];

    // Captcha rasmini yuklash
    const captchaResp = await firstValueFrom(
      this.httpService.get(formData.captchaImgUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          Accept: 'image/*,*/*',
          Referer: this.lastDebtPageUrl || `${this.BASE_URL}/home`,
          Cookie: this.session.cookies,
        },
      }),
    );
    this.saveCookies(captchaResp.headers['set-cookie']);
    const imgBuf = Buffer.from(captchaResp.data);

    const strategies = await this.preprocessCaptcha(imgBuf);
    const worker = await this.getWorker();

    for (const { name, buffer } of strategies) {
      const { data } = await worker.recognize(buffer);
      ocrResults.push({ name, text: data.text.trim() });
    }

    return {
      success: answer !== null,
      captchaImgUrl: formData.captchaImgUrl,
      answer,
      ocrResults,
      message:
        answer !== null
          ? `Captcha yechildi: ${answer}`
          : 'Captcha yechilmadi. debug-captcha papkasidagi rasmlarni tekshiring.',
    };
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.terminate();
    }
  }
}
