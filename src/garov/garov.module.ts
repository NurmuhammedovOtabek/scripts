import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GarovService } from './garov.service';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  providers: [GarovService],
  exports: [GarovService],
})
export class GarovModule {}
