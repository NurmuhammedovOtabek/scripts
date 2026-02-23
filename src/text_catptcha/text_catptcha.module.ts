// captcha.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CaptchaController } from './text_catptcha.controller';
import { CaptchaSolverService } from './text_catptcha.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
  ],
  controllers: [CaptchaController],
  providers: [CaptchaSolverService],
  exports: [CaptchaSolverService],
})
export class CaptchaModule {}
