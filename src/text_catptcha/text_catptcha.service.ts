import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as Tesseract from 'tesseract.js';
import { Jimp } from 'jimp';
import { USER_AGENTS } from './user-agent.pool';

@Injectable()
export class CaptchaSolverService {
  private readonly logger = new Logger(CaptchaSolverService.name);

  // SESSION MA'LUMOTLARI
  private session = {
    csrfToken: '',
    xsrfToken: '',
    laravelSession: '',
    cookieString: '',
  };

  // User-Agent indeks
  private userAgentIndex = 0;

  // So'rovlar soni
  private requestCount = 0;
  private readonly MAX_REQUESTS = 15;
  private readonly TIME_WINDOW = 10000; // 1 daqiqa

  constructor(private readonly httpService: HttpService) {}

  // ============= USER-AGENT BOSHQARISH =============

  // Navbatdagi User-Agent ni olish
  private getNextUserAgent(): string {
    const userAgent = USER_AGENTS[this.userAgentIndex];

    // Indeksni yangilash (aylanma)
    this.userAgentIndex = (this.userAgentIndex + 1) % USER_AGENTS.length;

    this.logger.log(`User-Agent: ${userAgent.substring(0, 50)}...`);
    return userAgent;
  }

  // Tasodifiy User-Agent olish
  // private getRandomUserAgent(): string {
  //   const randomIndex = Math.floor(Math.random() * USER_AGENTS.length);
  //   return USER_AGENTS[randomIndex];
  // }

  // ============= SESSIYA FUNKSIYALARI =============

  // 1. ASOSIY SAHIFADAN TOKEN VA COOKIES OLISH
  async initializeSession(): Promise<void> {
    try {
      this.logger.log('Sessiya boshlanmoqda...');

      // Har safar yangi User-Agent
      // const userAgent = this.getRandomUserAgent();

      const response = await firstValueFrom(
        this.httpService.get('https://davreestr.uz/uz', {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
          },
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
      this.logger.error(`Sessiya boshlashda xatolik: ${error.message}`);
      throw error;
    }
  }

  // 2. CAPTCHA OLISH
  async fetchCaptcha(): Promise<Buffer> {
    try {
      if (!this.session.cookieString) {
        await this.initializeSession();
      }

      // Captcha uchun alohida User-Agent
      // const userAgent = this.getRandomUserAgent();

      const response = await firstValueFrom(
        this.httpService.get('https://davreestr.uz/captcha/generate', {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
            Referer: 'https://davreestr.uz/uz',
            Cookie: this.session.cookieString,
            'X-CSRF-TOKEN': this.session.xsrfToken,
            Connection: 'keep-alive',
          },
        }),
      );

      return Buffer.from(response.data);
    } catch (error) {
      this.logger.error(`Captcha olishda xatolik: ${error.message}`);
      throw error;
    }
  }

  // 3. STIR BO'YICHA QIDIRISH
  async searchByTin(tin: string): Promise<any> {
    try {
      // Rate limitni tekshirish
      await this.checkRateLimit();

      // Sessiyani tekshirish
      if (!this.session.csrfToken) {
        await this.initializeSession();
      }

      // Captcha yechish
      const captchaCode = await this.solveCaptcha();
      this.logger.log(`Captcha yechildi: ${captchaCode}`);

      // Qidiruv uchun alohida User-Agent
      // const userAgent = this.getRandomUserAgent();

      // FORM DATA
      const formData = new URLSearchParams();
      formData.append('_token', this.session.csrfToken);
      formData.append('type', 'org_tin');
      formData.append('org_tin', tin);
      formData.append('captcha', captchaCode);

      this.logger.log(`So'rov yuborilmoqda: 
        Token: ${this.session.csrfToken.substring(0, 20)}...
        STIR: ${tin}
        Captcha: ${captchaCode}
        User-Agent: ${'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'.substring(0, 30)}...
      `);

      // SO'ROV YUBORISH
      const response = await firstValueFrom(
        this.httpService.post(
          'https://davreestr.uz/data/get-info/search',
          formData.toString(),
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json, text/plain, */*',
              'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
              Origin: 'https://davreestr.uz',
              Referer: 'https://davreestr.uz/uz',
              Cookie: this.session.cookieString,
              'X-CSRF-TOKEN': this.session.xsrfToken,
              'X-Requested-With': 'XMLHttpRequest',
              Connection: 'keep-alive',
            },
          },
        ),
      );

      // Rate limitni yangilash
      this.requestCount++;

      // Rate limit ma'lumotlarini olish
      const remaining = response.headers['x-ratelimit-remaining'];
      this.logger.log(`Qolgan so'rovlar: ${remaining}/15`);

      return {
        success: true,
        data: response.data,
        rateLimit: {
          remaining: remaining,
          limit: response.headers['x-ratelimit-limit'],
        },
      };
    } catch (error) {
      this.logger.error(`Xatolik: ${error.message}`);

      if (error.response) {
        this.logger.error(`Status: ${error.response.status}`);

        // 429 - Rate limit
        if (error.response.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 10;
          this.logger.log(`429 xatosi: ${retryAfter} sekund kutish...`);

          await this.delay(retryAfter * 1000);

          // Yangi User-Agent bilan qayta urinish
          this.logger.log('Yangi User-Agent bilan qayta urinilmoqda...');
          return this.searchByTin(tin);
        }

        // 419 - Token muammosi
        if (error.response.status === 419) {
          this.logger.log('Token eskirgan, qayta urinilmoqda...');
          this.clearSession();
          await this.delay(2000);
          return this.searchByTin(tin);
        }

        // 422 - Captcha xato
        if (error.response.status === 422) {
          this.logger.log('Captcha xato, qayta urinilmoqda...');
          return this.searchByTin(tin);
        }
      }

      throw error;
    }
  }

  // ============= RATE LIMIT BOSHQARISH =============

  private async checkRateLimit(): Promise<void> {
    // Har 15 so'rovdan keyin 1 daqiqa kutish
    if (this.requestCount >= this.MAX_REQUESTS) {
      this.logger.warn('Rate limit chegarasiga yetildi, 1 daqiqa kutish...');
      await this.delay(this.TIME_WINDOW);
      this.requestCount = 0;
    }
  }

  // ============= CAPTCHA FUNKSIYALARI =============

  async solveCaptcha(): Promise<string> {
    const rawImage = await this.fetchCaptcha();
    // const enhancedImage = await this.enhanceImage(rawImage);
    return this.readWithTesseract(rawImage);
  }

  // async enhanceImage(buffer: Buffer): Promise<Buffer> {
  //   try {
  //     const image = await Jimp.read(buffer);

  //     image
  //       .greyscale()
  //       .contrast(0.5)
  //       .normalize()
  //       .threshold({ max: 128 })
  //       .invert()
  //       .resize({ w: 400, h: 100 });

  //     const output = await image.getBuffer('image/png');

  //     return output;
  //   } catch (error: any) {
  //     console.error(error);
  //     return buffer;
  //   }
  // }

  // Tesseract worker
  private worker: Tesseract.Worker | null = null;

  async getWorker(): Promise<Tesseract.Worker> {
    if (!this.worker) {
      this.worker = await Tesseract.createWorker('eng');
      await this.worker.setParameters({
        tessedit_char_whitelist: '0123456789',
      });
    }
    return this.worker;
  }

  async readWithTesseract(buffer: Buffer): Promise<string> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(buffer);
    return data.text.replace(/[^0-9]/g, '').substring(0, 4);
  }

  // Yordamchi funksiyalar
  private extractCookieValue(cookie: string): string {
    const match = cookie.match(/=([^;]+)/);
    return match ? match[1] : '';
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  clearSession() {
    this.session = {
      csrfToken: '',
      xsrfToken: '',
      laravelSession: '',
      cookieString: '',
    };
    this.logger.log('Sessiya tozalandi');
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.terminate();
    }
  }
}
