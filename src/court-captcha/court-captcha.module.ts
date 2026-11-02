import { Module } from '@nestjs/common';
import { CourtCaptchaService } from './court-captcha.service';

@Module({
  providers: [CourtCaptchaService],
  exports: [CourtCaptchaService],
})
export class CourtCaptchaModule {}
