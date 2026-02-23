// captcha.controller.ts
import { Controller, Post, Body, Get } from '@nestjs/common';
import { CaptchaSolverService } from './text_catptcha.service';

@Controller('captcha')
export class CaptchaController {
  constructor(private readonly captchaSolver: CaptchaSolverService) {}

  @Post('solve')
  async solveCaptcha(@Body('tin') tin: string) {
    try {
      const result = await this.captchaSolver.searchByTin(tin);
      return {
        success: true,
        data: result.data,
        message: "Ma'lumotlar topildi",
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // @Get('test')
  // async testCaptcha() {
  //   // Faqat captcha yechishni test qilish
  //   try {
  //     const captcha = await this.captchaSolver.getCaptchaCode();
  //     return {
  //       success: true,
  //       captcha: captcha
  //     };
  //   } catch (error) {
  //     return {
  //       success: false,
  //       error: error.message
  //     };
  //   }
  // }
}
