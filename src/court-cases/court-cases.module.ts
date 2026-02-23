import { Module } from '@nestjs/common';
import { CourtCasesService } from './court-cases.service';

@Module({
  providers: [CourtCasesService],
  exports: [CourtCasesService],
})
export class CourtCasesModule {}
