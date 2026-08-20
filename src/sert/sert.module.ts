import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SertScriptService } from './sert.service';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  providers: [SertScriptService],
  exports: [SertScriptService],
})
export class SertModule {}
