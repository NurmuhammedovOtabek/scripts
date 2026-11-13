import { Module } from '@nestjs/common';
import { ContactFillService } from './contact-fill.service';
import { ContactFillController } from './contact-fill.controller';

@Module({
  providers: [ContactFillService],
  controllers: [ContactFillController],
})
export class ContactFillModule {}
