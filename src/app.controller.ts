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

  @Get('cadastre')
  getCadastre(@Query('tin') tin: string) {
    return this.appService.getCadastreByTin(tin);
  }

  @Get('cadastre/by-number')
  getCadastreByNumber(@Query('cad') cad: string) {
    return this.appService.getCadastreByNumber(cad);
  }

  @Get('tax-risk')
  getTaxRisk(@Query('tin') tin?: string, @Query('pinfl') pinfl?: string) {
    return this.appService.getTaxRisk(tin, pinfl);
  }

  @Get('tax-debt')
  getTaxDebt(@Query('tin') tin?: string, @Query('pinfl') pinfl?: string) {
    return this.appService.getTaxDebt(tin, pinfl);
  }

  @Get('garov')
  getGarov(@Query('inn') inn?: string, @Query('pinfl') pinfl?: string) {
    return this.appService.getGarov(inn, pinfl);
  }

  @Get('sert')
  getSert(@Query('tin') tin: string) {
    return this.appService.getCertificates(tin);
  }

  @Get('mib')
  getMib(@Query('tin') tin?: string, @Query('pinfl') pinfl?: string) {
    return this.appService.getMibDebts(tin, pinfl);
  }

  @Get('large-taxpayer')
  getLargeTaxpayer(@Query('tin') tin: string) {
    return this.appService.getLargeTaxpayer(tin);
  }
}
