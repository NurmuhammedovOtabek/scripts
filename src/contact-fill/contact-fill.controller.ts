import { Controller, Get, Post, Query } from '@nestjs/common';
import { ContactFillService } from './contact-fill.service';

@Controller('contact-fill')
export class ContactFillController {
  constructor(private readonly fill: ContactFillService) {}

  @Post('run')
  run(@Query('target') target?: string) {
    return this.fill.run(target || 'prod');
  }

  @Get('status')
  status() {
    return this.fill.status();
  }
}
