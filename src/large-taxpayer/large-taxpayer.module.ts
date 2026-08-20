import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { LargeTaxpayerService } from './large-taxpayer.service';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  providers: [LargeTaxpayerService],
  exports: [LargeTaxpayerService],
})
export class LargeTaxpayerModule {}
