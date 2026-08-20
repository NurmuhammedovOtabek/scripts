import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DavreestrService } from './davreestr.service';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  providers: [DavreestrService],
  exports: [DavreestrService],
})
export class DavreestrModule {}
