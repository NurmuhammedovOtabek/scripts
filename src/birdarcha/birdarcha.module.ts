import { Module } from '@nestjs/common';
import { BirdarchaService } from './birdarcha.service';

@Module({
  providers: [BirdarchaService],
  exports: [BirdarchaService],
})
export class BirdarchaModule {}
