import { Module } from '@nestjs/common';
import { StatRegistryService } from './stat-registry.service';

@Module({
  providers: [StatRegistryService],
  exports: [StatRegistryService],
})
export class StatRegistryModule {}
