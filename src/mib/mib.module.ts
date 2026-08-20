import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MibScriptService } from './mib.service';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  providers: [MibScriptService],
  exports: [MibScriptService],
})
export class MibModule {}
