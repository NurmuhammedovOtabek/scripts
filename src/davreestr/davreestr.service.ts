import { Injectable, Logger, Inject } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { USER_AGENTS } from './user-agent.pool';
import { HtmlParserService } from '../html-parser/html-parser.service';
import { CaptchaSolverClient } from '../common/captcha-solver.client';
import { MemoryCacheService } from '../common/memory-cache.service';
import { NoProxyPool } from '../common/no-proxy.pool';

@Injectable()
export class DavreestrService {
  private readonly logger = new Logger(DavreestrService.name);

  // SESSION MA'LUMOTLARI
  // userAgent sessiya davomida qat'iy (haqiqiy brauzer kabi) — sessiya tozalanganda
  // keyingi sessiyada yangi UA tanlanadi.
  private session = {
    csrfToken: '',
    xsrfToken: '',
    laravelSession: '',
    cookieString: '',
    userAgent: '',
    /**
     * The address this session speaks from, null when it is our own.
     *
     * Pinned for the session's whole life on purpose: davreestr binds the
     * captcha to the cookies and User-Agent that fetched it, so changing
     * address between the captcha and the search invalidates it and every
     * search would come back "wrong captcha".
     */
    proxy: null as string | null,
    /**
     * Built once with the proxy above rather than per request. A session makes
     * six calls, and a fresh agent for each one throws away the connection the
     * previous call opened — six TLS handshakes through a slow free proxy
     * instead of one.
     */
    proxyAgent: null as unknown,
  };

  // User-Agent indeks
  private userAgentIndex = 0;

  // So'rovlar soni va vaqt oynasi
  // davreestr.uz X-RateLimit-Limit = 15 per minute (observed)
  private requestCount = 0;
  private readonly MAX_REQUESTS = 15;
  private readonly TIME_WINDOW = 60000;
  private windowStart = Date.now();

  // Cache: davreestr ma'lumotlari 24 soatga keshlashadi (kompaniya / mulk
  // ma'lumoti kam o'zgaradi). Faqat muvaffaqiyatli natija keshlashadi.
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly CACHE_GET_TIMEOUT_MS = 2000;

  constructor(
    private readonly httpService: HttpService,
    private readonly htmlParser: HtmlParserService,
    private readonly solverClient: CaptchaSolverClient,
    private readonly cacheManager: MemoryCacheService,
    private readonly proxyPool: NoProxyPool,
  ) {}

  /** Ceilings on how long a davreestr request may take. */
  private readonly DIRECT_TIMEOUT_MS = 30_000;
  private readonly PROXY_TIMEOUT_MS = 10_000;

  /**
   * What every request in this session must carry.
   *
   * `proxy: false` is not redundant next to the agent — axios would otherwise
   * read HTTP_PROXY from the environment and apply its own handling on top,
   * and the two disagree about how to CONNECT through to TLS.
   */
  private get transport(): Record<string, unknown> {
    if (!this.session.proxy) {
      // davreestr had no timeout at all before this, so a hung government
      // site hung the request behind it — and the cadastre lookup is on the
      // path a user is waiting on.
      return { timeout: this.DIRECT_TIMEOUT_MS };
    }
    return {
      httpsAgent: this.session.proxyAgent,
      proxy: false,
      // Tighter than direct on purpose. A proxy that answered its probe
      // minutes ago can be gone now, and the session should find that out in
      // seconds rather than spending the user's patience on it. A working one
      // measured 1.6-4.8s for the same page.
      timeout: this.PROXY_TIMEOUT_MS,
    };
  }

  // ============= CACHE YORDAMCHILARI =============

  /**
   * Sahifa e'lon qilgan sondan kam raqam ajratib olinganmi.
   *
   * davreestr javobining o'zida tekshirish bor — undan foydalanmaslik
   * qisman parse'ni to'liq javobdan ajratib bo'lmaydigan qilib qo'yadi.
   */
  isPartial(parsed: {
    totalCount?: number;
    cadNumbers?: string[];
    rowsSeen?: number;
  }): boolean {
    const declared = Number(parsed?.totalCount) || 0;

    // The question is how much of the page we accounted for, and there are two
    // honest answers depending on the page.
    //
    // Rows, when a parcel carries several objects: the register counts
    // OBJECTS, so eight objects on three parcels is a complete answer that
    // three distinct numbers cannot vouch for. Reading it the other way is
    // what made INN 304701231 look like a two-thirds loss and got its correct
    // data thrown away on every sync.
    //
    // Distinct numbers, when the text fallback found results the radio inputs
    // did not: rows undercounts then, and five numbers against a declared five
    // is complete however we came by them.
    //
    // Neither alone is right, so take whichever accounts for more.
    const rows = Number(parsed?.rowsSeen) || 0;
    const numbers = parsed?.cadNumbers?.length ?? 0;
    return declared > Math.max(rows, numbers);
  }

  private cacheKeyForTin(tin: string): string {
    return `davreestr:tin:${tin}`;
  }

  private cacheKeyForCad(cadNumber: string): string {
    return `davreestr:cad:${cadNumber}`;
  }

  private async cacheGet<T>(key: string): Promise<T | undefined> {
    try {
      const cached = await Promise.race([
        this.cacheManager.get<T>(key),
        new Promise<T | undefined>((_, reject) =>
          setTimeout(
            () => reject(new Error('cache timeout')),
            this.CACHE_GET_TIMEOUT_MS,
          ),
        ),
      ]);
      return cached ?? undefined;
    } catch (err) {
      this.logger.warn(
        `[cache] get failed (key=${key}): ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  private async cacheSet<T>(key: string, value: T): Promise<void> {
    try {
      await Promise.race([
        this.cacheManager.set(key, value, this.CACHE_TTL_MS),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('cache timeout')),
            this.CACHE_GET_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      this.logger.warn(
        `[cache] set failed (key=${key}): ${(err as Error).message}`,
      );
    }
  }

  // ============= USER-AGENT ROTATION =============

  // Pick the next User-Agent from the pool (round-robin).
  private getNextUserAgent(): string {
    const userAgent = USER_AGENTS[this.userAgentIndex];
    this.userAgentIndex = (this.userAgentIndex + 1) % USER_AGENTS.length;
    // Per-request UA selection is debug — too noisy at log level.
    this.logger.debug(`[ua] selected: ${userAgent.substring(0, 50)}...`);
    return userAgent;
  }

  // Joriy sessiyada UA — birinchi chaqiriqda tanlanadi, sessiya tozalangunga qadar
  // o'zgarmaydi. Bu davreestr.uz tomonidan "brauzer sessiyasi" sifatida
  // ko'rinishiga yordam beradi (UA sessiya o'rtasida o'zgarsa, bu juda ham
  // shubhali signal).
  private getSessionUserAgent(): string {
    if (!this.session.userAgent) {
      this.session.userAgent = this.getNextUserAgent();
    }
    return this.session.userAgent;
  }

  // Tasodifiy User-Agent olish
  // private getRandomUserAgent(): string {
  //   const randomIndex = Math.floor(Math.random() * USER_AGENTS.length);
  //   return USER_AGENTS[randomIndex];
  // }

  // ============= SESSIYA FUNKSIYALARI =============

  // 1. ASOSIY SAHIFADAN TOKEN VA COOKIES OLISH
  async initializeSession(forceDirect = false): Promise<void> {
    try {
      // Chosen once, here, and kept for the session's whole life — see the
      // note on session.proxy. Null means our own address, which is what
      // every session used before the pool existed and what it falls back to
      // whenever the pool has nothing.
      //
      // `forceDirect` is how the retry below avoids picking another proxy —
      // and avoids picking the SAME one, which is still in the pool until it
      // has failed three times.
      this.session.proxy = forceDirect ? null : this.proxyPool.acquire();
      this.session.proxyAgent = this.session.proxy
        ? this.proxyPool.agentFor(this.session.proxy)
        : null;
      this.logger.log(
        `Sessiya boshlanmoqda... ${this.session.proxy ? `proxy=${this.session.proxy}` : "o'z IP"}`,
      );

      // Har safar yangi User-Agent
      // const userAgent = this.getRandomUserAgent();

      const response = await firstValueFrom(
        this.httpService.get('https://davreestr.uz/uz', {
          headers: {
            'User-Agent': this.getSessionUserAgent(),
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
          },
          ...this.transport,
        }),
      );

      // HTML dan CSRF TOKEN olish
      const html = response.data;

      // Meta tagdan olish
      const metaMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
      if (metaMatch) {
        this.session.csrfToken = metaMatch[1];
        this.logger.log(`CSRF token olindi: ${this.session.csrfToken}`);
      }

      // COOKIES larni olish
      const cookies = response.headers['set-cookie'];
      if (cookies) {
        cookies.forEach((cookie) => {
          if (cookie.includes('XSRF-TOKEN')) {
            this.session.xsrfToken = this.extractCookieValue(cookie);
          } else if (cookie.includes('laravel_session')) {
            this.session.laravelSession = this.extractCookieValue(cookie);
          }
        });

        this.session.cookieString = `XSRF-TOKEN=${this.session.xsrfToken}; laravel_session=${this.session.laravelSession}`;
        this.logger.log('Cookies olindi');
      }
    } catch (error) {
      // A proxy that cannot even open the session is no use for the rest of
      // it. Rather than fail the lookup, drop it and start again on our own
      // address — the user waits one timeout instead of losing the answer.
      if (this.session.proxy && !error.response) {
        const dead = this.session.proxy;
        this.proxyPool.report(dead, false);
        this.session.proxy = null;
        this.session.proxyAgent = null;
        this.logger.warn(
          `[proxy] ${dead} sessiyani ocholmadi — o'z IP bilan qayta urinilmoqda`,
        );
        return this.initializeSession(true);
      }
      this.logger.error(`Sessiya boshlashda xatolik: ${error.message}`);
      throw error;
    }
  }

  // 2. CAPTCHA OLISH
  // Captcha img URL - HTML dan olinadi
  private captchaImgUrl = '';

  async fetchCaptcha(): Promise<Buffer> {
    try {
      if (!this.session.cookieString) {
        await this.initializeSession();
      }

      // Avval HTML dan captcha img URL ni olish
      if (!this.captchaImgUrl) {
        await this.extractCaptchaUrl();
      }

      const captchaUrl =
        this.captchaImgUrl || 'https://davreestr.uz/captcha/default';

      this.logger.log(`Captcha URL: ${captchaUrl}`);

      const response = await firstValueFrom(
        this.httpService.get(captchaUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': this.getSessionUserAgent(),
            Accept: 'image/*,*/*',
            'Accept-Language': 'en,en-US;q=0.9,ru;q=0.8',
            Referer: 'https://davreestr.uz/uz',
            Cookie: this.session.cookieString,
            Connection: 'keep-alive',
          },
          ...this.transport,
        }),
      );

      // Cookies yangilash
      this.updateCookies(response.headers['set-cookie']);

      return Buffer.from(response.data);
    } catch (error) {
      this.logger.error(`Captcha olishda xatolik: ${error.message}`);
      throw error;
    }
  }

  // HTML sahifadan captcha img URL ni olish
  private async extractCaptchaUrl(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.httpService.get('https://davreestr.uz/uz', {
          headers: {
            'User-Agent': this.getSessionUserAgent(),
            Accept: 'text/html,*/*',
            Cookie: this.session.cookieString,
          },
          ...this.transport,
        }),
      );

      this.updateCookies(response.headers['set-cookie']);

      const html = String(response.data);
      // <img alt="Captcha" src="https://davreestr.uz/captcha/default?yjKVhC40">
      const imgMatch = html.match(/captcha\/default\?[^"'\s]+/);
      if (imgMatch) {
        this.captchaImgUrl = `https://davreestr.uz/${imgMatch[0]}`;
        this.logger.log(`Captcha URL topildi: ${this.captchaImgUrl}`);
      }

      // CSRF token yangilash
      const metaMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
      if (metaMatch) {
        this.session.csrfToken = metaMatch[1];
      }
    } catch (error) {
      this.logger.warn(`Captcha URL olishda xatolik: ${error.message}`);
    }
  }

  // 3. STIR BO'YICHA QIDIRISH
  private readonly MAX_SEARCH_RETRIES = 3;

  async searchByTin(tin: string, retryCount = 0): Promise<any> {
    try {
      // Cache'dan tekshirish (faqat birinchi urinishda — retrylar davrida qayta
      // o'qimaymiz, chunki retry aynan yangi so'rov qilishga mo'ljallangan)
      if (retryCount === 0) {
        const cacheKey = this.cacheKeyForTin(tin);
        const cached = await this.cacheGet<any>(cacheKey);
        if (cached !== undefined) {
          this.logger.log(`[CACHE HIT] davreestr TIN=${tin}`);
          return { success: true, data: cached, rateLimit: { cached: true } };
        }
        this.logger.log(`[CACHE MISS] davreestr TIN=${tin}`);
      }

      // Rate limitni tekshirish
      await this.checkRateLimit();

      // Sessiyani tekshirish
      if (!this.session.csrfToken) {
        await this.initializeSession();
      }

      // Captcha yechish
      const captchaCode = await this.solveCaptcha();
      this.logger.log(`Captcha yechildi: ${captchaCode}`);

      // FORM DATA
      const formData = new URLSearchParams();
      formData.append('_token', this.session.csrfToken);
      formData.append('type', 'org_tin');
      formData.append('cad_number', '');
      formData.append('org_tin', tin);
      formData.append('captcha', captchaCode);

      this.logger.log(
        `So'rov yuborilmoqda: STIR=${tin}, Captcha=${captchaCode}`,
      );

      const response = await firstValueFrom(
        this.httpService.post(
          'https://davreestr.uz/data/get-info/search',
          formData.toString(),
          {
            headers: {
              'User-Agent': this.getSessionUserAgent(),
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
              'Accept-Language': 'en,en-US;q=0.9,ru;q=0.8',
              Origin: 'https://davreestr.uz',
              Referer: 'https://davreestr.uz/uz',
              Cookie: this.session.cookieString,
              Connection: 'keep-alive',
              'Cache-Control': 'max-age=0',
              'Upgrade-Insecure-Requests': '1',
            },
            ...this.transport,
          },
        ),
      );

      // Rate limitni yangilash
      this.requestCount++;

      // Cookies ni yangilash
      this.updateCookies(response.headers['set-cookie']);

      const remaining = response.headers['x-ratelimit-remaining'];
      this.logger.log(`Qolgan so'rovlar: ${remaining}`);

      // HTML javobni parse qilish
      const html = String(response.data || '');
      const parsed = this.htmlParser.parseDavreestr(html);

      // Diagnostika: agar dummy 99:99:... raqamlari kelgan bo'lsa, butun
      // HTML javobni faylga saqlab qo'yamiz, keyin qo'lda tekshiriladi.
      const hasDummy =
        Array.isArray(parsed.cadNumbers) &&
        parsed.cadNumbers.some((n: string) =>
          String(n || '').startsWith('99:99:99:99:99:9999'),
        );
      if (hasDummy) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const fs = require('fs/promises');
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const path = require('path');
          const dir = path.join(process.cwd(), 'data', 'davreestr-dumps');
          await fs.mkdir(dir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const file = path.join(dir, `dummy-${tin}-${ts}.html`);
          await fs.writeFile(file, html, 'utf8');
          this.logger.warn(
            `[davreestr DUMP] TIN=${tin} dummy javobi saqlandi: ${file}`,
          );
          // 99:99:... atrofidagi 200ta belgini ham log'da ko'rsatamiz
          const idx = html.indexOf('99:99:99:99:99:9999');
          if (idx !== -1) {
            const start = Math.max(0, idx - 200);
            const end = Math.min(html.length, idx + 200);
            this.logger.warn(
              `[davreestr DUMP] TIN=${tin} kontekst (yon-atrof):\n${html.substring(start, end)}`,
            );
          }
        } catch (e) {
          this.logger.error(
            `[davreestr DUMP] saqlash xato: ${(e as any).message}`,
          );
        }
      }

      // Captcha xato bo'lsa, cheklangan retry
      if (
        !parsed.success &&
        parsed.error &&
        parsed.error.includes("noto'g'ri") &&
        retryCount < this.MAX_SEARCH_RETRIES
      ) {
        this.logger.warn(
          `Captcha xato (${retryCount + 1}/${this.MAX_SEARCH_RETRIES}), qayta urinish...`,
        );
        await this.delay(1000);
        return this.searchByTin(tin, retryCount + 1);
      }

      // Faqat muvaffaqiyatli natijani keshlashimiz kerak — topilmagan / xatolik
      // natijalarni keshlash yangi ro'yxatdan o'tgan firmalar uchun false-negativni
      // qoldirib ketadi.
      //
      // Qisman javob ham keshlanmaydi. Sahifa nechta obyekt borligini o'zi
      // yozadi ("Topilgan Obyektlar Soni: 12"), va agar biz shundan kamini
      // ajratib olgan bo'lsak — bu to'liq javob emas. Ilgari u ham `success`
      // hisoblanib, sutkalik keshga tushardi: INN 300922269 uchun o'n
      // ikkitadan bittasi keshlanib, har so'rov CACHE HIT bilan o'sha bitta
      // raqamni qaytarardi.
      if (parsed.success && !this.isPartial(parsed)) {
        await this.cacheSet(this.cacheKeyForTin(tin), parsed);
      }

      return {
        success: parsed.success,
        data: parsed,
        rateLimit: {
          remaining: remaining,
          limit: response.headers['x-ratelimit-limit'],
        },
      };
    } catch (error) {
      this.logger.error(`Xatolik: ${error.message}`);

      // No response at all means the request never arrived — a dead or
      // refusing proxy looks exactly like this, and it is the only failure
      // the proxy can fairly be blamed for. Anything with an HTTP status
      // reached davreestr, so the address did its job whatever it answered.
      if (!error.response && this.session.proxy) {
        this.proxyPool.report(this.session.proxy, false);
      }

      if (error.response && retryCount < this.MAX_SEARCH_RETRIES) {
        const status = error.response.status;
        this.logger.error(`Status: ${status}`);

        // 429 - Rate limit
        if (status === 429) {
          const retryAfter =
            parseInt(error.response.headers['retry-after']) || 60;
          this.logger.warn(`429: ${retryAfter} sek kutish...`);
          await this.delay(retryAfter * 1000);
          return this.searchByTin(tin, retryCount + 1);
        }

        // 419 - Token eskirgan
        if (status === 419) {
          this.logger.warn('419: Token eskirgan, sessiya yangilanmoqda...');
          this.clearSession();
          await this.delay(2000);
          return this.searchByTin(tin, retryCount + 1);
        }

        // 422 - Captcha xato
        if (status === 422) {
          this.logger.warn('422: Captcha xato, qayta urinish...');
          await this.delay(1000);
          return this.searchByTin(tin, retryCount + 1);
        }
      }

      throw error;
    }
  }

  // 4. KADASTR RAQAMI BO'YICHA QIDIRISH
  async searchByCadNumber(cadNumber: string, retryCount = 0): Promise<any> {
    try {
      // Cache'dan tekshirish (faqat birinchi urinishda)
      if (retryCount === 0) {
        const cacheKey = this.cacheKeyForCad(cadNumber);
        const cached = await this.cacheGet<any>(cacheKey);
        if (cached !== undefined) {
          this.logger.log(`[CACHE HIT] davreestr CAD=${cadNumber}`);
          return { success: true, data: cached, rateLimit: { cached: true } };
        }
        this.logger.log(`[CACHE MISS] davreestr CAD=${cadNumber}`);
      }

      await this.checkRateLimit();

      if (!this.session.csrfToken) {
        await this.initializeSession();
      }

      // Yangi captcha olish (reload-captcha AJAX endpoint)
      await this.reloadCaptcha();

      // Captcha yechish
      const captchaCode = await this.solveCaptcha();
      this.logger.log(`Kadastr captcha yechildi: ${captchaCode}`);

      // FORM DATA
      const formData = new URLSearchParams();
      formData.append('_token', this.session.csrfToken);
      formData.append('cad_number_search', cadNumber);
      formData.append('captcha', captchaCode);

      this.logger.log(`Kadastr so'rov: ${cadNumber}, Captcha=${captchaCode}`);

      const response = await firstValueFrom(
        this.httpService.post(
          'https://davreestr.uz/data/get-info/cadastr-number',
          formData.toString(),
          {
            headers: {
              'User-Agent': this.getSessionUserAgent(),
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
              'Accept-Language': 'en,en-US;q=0.9,ru;q=0.8',
              Origin: 'https://davreestr.uz',
              Referer: 'https://davreestr.uz/data/get-info/search',
              Cookie: this.session.cookieString,
              Connection: 'keep-alive',
              'Cache-Control': 'max-age=0',
              'Upgrade-Insecure-Requests': '1',
            },
            ...this.transport,
          },
        ),
      );

      this.requestCount++;
      this.updateCookies(response.headers['set-cookie']);

      const remaining = response.headers['x-ratelimit-remaining'];
      this.logger.log(`Kadastr qolgan so'rovlar: ${remaining}`);

      const html = String(response.data || '');
      const parsed = this.htmlParser.parseCadProperty(html);

      // Captcha xato bo'lsa retry
      if (
        !parsed.success &&
        parsed.error &&
        parsed.error.includes("noto'g'ri") &&
        retryCount < this.MAX_SEARCH_RETRIES
      ) {
        this.logger.warn(
          `Kadastr captcha xato (${retryCount + 1}/${this.MAX_SEARCH_RETRIES})`,
        );
        await this.delay(1000);
        return this.searchByCadNumber(cadNumber, retryCount + 1);
      }

      if (parsed.success) {
        await this.cacheSet(this.cacheKeyForCad(cadNumber), parsed);
      }

      return {
        success: parsed.success,
        data: parsed,
        rateLimit: {
          remaining,
          limit: response.headers['x-ratelimit-limit'],
        },
      };
    } catch (error) {
      this.logger.error(`Kadastr xatolik: ${error.message}`);

      // Same reasoning as searchByTin: only a request that never landed can
      // be the proxy's fault.
      if (!error.response && this.session.proxy) {
        this.proxyPool.report(this.session.proxy, false);
      }

      if (error.response && retryCount < this.MAX_SEARCH_RETRIES) {
        const status = error.response.status;

        if (status === 429) {
          const retryAfter =
            parseInt(error.response.headers['retry-after']) || 60;
          this.logger.warn(`429: ${retryAfter} sek kutish...`);
          await this.delay(retryAfter * 1000);
          return this.searchByCadNumber(cadNumber, retryCount + 1);
        }

        if (status === 419) {
          this.clearSession();
          await this.delay(2000);
          return this.searchByCadNumber(cadNumber, retryCount + 1);
        }

        if (status === 422) {
          await this.delay(1000);
          return this.searchByCadNumber(cadNumber, retryCount + 1);
        }
      }

      throw error;
    }
  }

  // Captcha yangilash (AJAX endpointi)
  private async reloadCaptcha(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.httpService.get('https://davreestr.uz/reload-captcha', {
          headers: {
            'User-Agent': this.getSessionUserAgent(),
            Accept: '*/*',
            Referer: 'https://davreestr.uz/data/get-info/search',
            Cookie: this.session.cookieString,
            'X-Requested-With': 'XMLHttpRequest',
          },
          ...this.transport,
        }),
      );

      this.updateCookies(response.headers['set-cookie']);

      // JSON javob: captcha img URL yoki boshqa ma'lumot
      const data = response.data;
      if (data && typeof data === 'object') {
        // Agar captcha URL qaytsa
        if (data.captcha) {
          // HTML img tag ichidan src olish
          const srcMatch = String(data.captcha).match(/src="([^"]+)"/);
          if (srcMatch) {
            this.captchaImgUrl = srcMatch[1];
            this.logger.log(`Reload captcha URL: ${this.captchaImgUrl}`);
            return;
          }
        }
      }

      // Fallback — HTML dan yangi captcha URL olish
      this.captchaImgUrl = '';
    } catch (error) {
      this.logger.warn(`Reload captcha xato: ${error.message}`);
      this.captchaImgUrl = '';
    }
  }

  // ============= RATE LIMIT BOSHQARISH =============

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    // Vaqt oynasi o'tgan bo'lsa, hisoblagichni qayta boshlash
    if (now - this.windowStart >= this.TIME_WINDOW) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    // Chegaraga yetgan bo'lsa, qolgan vaqtni kutish
    if (this.requestCount >= this.MAX_REQUESTS) {
      const waitMs = this.TIME_WINDOW - (now - this.windowStart);
      this.logger.warn(`Rate limit: ${Math.ceil(waitMs / 1000)} sek kutish...`);
      await this.delay(waitMs);
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
  }

  // ============= CAPTCHA FUNKSIYALARI =============

  private readonly MAX_CAPTCHA_ATTEMPTS = 5;

  /**
   * Get a 4-digit captcha code via the Python captcha-solver microservice
   * (ddddocr). Fetches a fresh captcha image per attempt; returns on the
   * first 4-digit answer.
   */
  async solveCaptcha(): Promise<string> {
    for (let attempt = 1; attempt <= this.MAX_CAPTCHA_ATTEMPTS; attempt++) {
      this.logger.log(
        `Captcha yechish urinishi: ${attempt}/${this.MAX_CAPTCHA_ATTEMPTS}`,
      );

      this.captchaImgUrl = '';
      const rawImage = await this.fetchCaptcha();

      const code = await this.solverClient.solve(rawImage, {
        type: 'digits',
        length: 4,
      });
      if (code) {
        this.logger.log(`Captcha yechildi (urinish ${attempt}): ${code}`);
        return code;
      }

      this.logger.warn(
        `Urinish ${attempt}: solver 4 xonali natija bermadi, yangi captcha olinmoqda...`,
      );
    }

    throw new Error(
      `${this.MAX_CAPTCHA_ATTEMPTS} urinishdan keyin captcha yechilmadi`,
    );
  }

  // Yordamchi funksiyalar
  private updateCookies(setCookieHeader: string[] | undefined) {
    if (!setCookieHeader) return;
    const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [];
    for (const c of arr) {
      if (c.includes('XSRF-TOKEN')) {
        this.session.xsrfToken = this.extractCookieValue(c);
      } else if (c.includes('laravel_session')) {
        this.session.laravelSession = this.extractCookieValue(c);
      }
    }
    this.session.cookieString = `XSRF-TOKEN=${this.session.xsrfToken}; laravel_session=${this.session.laravelSession}`;
  }

  private extractCookieValue(cookie: string): string {
    const match = cookie.match(/=([^;]+)/);
    return match ? match[1] : '';
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Drop the session.
   *
   * `ok` is how the pool learns: it is called with false from the retry paths,
   * where the session failed and the address it used is a suspect. Three of
   * those in a row and the proxy is dropped — not the first, because
   * davreestr returns the occasional error of its own and blaming the proxy
   * for those would empty the pool in a morning.
   */
  clearSession(ok = true) {
    if (this.session.proxy) this.proxyPool.report(this.session.proxy, ok);
    this.session = {
      csrfToken: '',
      xsrfToken: '',
      laravelSession: '',
      cookieString: '',
      userAgent: '',
      proxy: null,
      proxyAgent: null,
    };
    this.captchaImgUrl = '';
    this.logger.log('Sessiya tozalandi');
  }
}
