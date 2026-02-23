import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { StatRegistryModule } from './stat-registry/stat-registry.module';
import { CourtCasesModule } from './court-cases/court-cases.module';
import { LicenseModule } from './license/license.module';
import { CaptchaModule } from './text_catptcha/text_catptcha.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    StatRegistryModule,
    CourtCasesModule,
    LicenseModule,
    CaptchaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
