import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TaxDebtorService } from './tax-debtor.service';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  providers: [TaxDebtorService],
  exports: [TaxDebtorService],
})
export class TaxDebtorModule {}
