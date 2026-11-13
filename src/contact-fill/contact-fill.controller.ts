import { Controller, Get, Post } from '@nestjs/common';
import { ContactFillService } from './contact-fill.service';

@Controller('contact-fill')
export class ContactFillController {
  constructor(private readonly fill: ContactFillService) {}

  @Post('run')
  run() {
    return this.fill.run();
  }

  @Get('status')
  status() {
    return this.fill.status();
  }
}
