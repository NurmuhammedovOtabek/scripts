import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('main')
  getFromStatus(@Query('inn') inn?: string) {
    return this.appService.getFromStatus(inn || '312387381');
  }

  @Get('litsens')
  getLitsens(@Query('tin') tin?: string) {
    return this.appService.getLicensesByTin(tin || '302114274');
  }

  @Get('sud')
  getSud(@Query('tin') tin?: string, @Query('case') caseNumber?: string) {
    return this.appService.getCourtCases(tin, caseNumber);
  }

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  @Get('stats')
  getStats() {
    return this.appService.getLicenseStats();
  }
}
