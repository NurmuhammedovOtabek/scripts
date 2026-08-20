import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TaxRiskService } from './tax-risk.service';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  providers: [TaxRiskService],
  exports: [TaxRiskService],
})
export class TaxRiskModule {}
