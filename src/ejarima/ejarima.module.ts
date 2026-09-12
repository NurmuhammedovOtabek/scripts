import { Module } from '@nestjs/common';
import { EjarimaService } from './ejarima.service';

@Module({
  providers: [EjarimaService],
  exports: [EjarimaService],
})
export class EjarimaModule {}
