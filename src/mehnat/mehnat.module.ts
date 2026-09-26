import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MehnatService } from './mehnat.service';

@Module({
  imports: [HttpModule.register({ timeout: 15000 })],
  providers: [MehnatService],
  exports: [MehnatService],
})
export class MehnatModule {}
