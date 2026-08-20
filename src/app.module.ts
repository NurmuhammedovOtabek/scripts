import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { StatRegistryModule } from './stat-registry/stat-registry.module';
import { CourtCasesModule } from './court-cases/court-cases.module';
import { LicenseModule } from './license/license.module';
import { CaptchaModule } from './text_catptcha/text_catptcha.module';
import { CommonModule } from './common/common.module';
import { DavreestrModule } from './davreestr/davreestr.module';
import { TaxRiskModule } from './tax-risk/tax-risk.module';
import { TaxDebtorModule } from './tax-debtor/tax-debtor.module';
import { GarovModule } from './garov/garov.module';
import { SertModule } from './sert/sert.module';
import { MibModule } from './mib/mib.module';
import { LargeTaxpayerModule } from './large-taxpayer/large-taxpayer.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    StatRegistryModule,
    CourtCasesModule,
    LicenseModule,
    CaptchaModule,
    CommonModule,
    DavreestrModule,
    TaxRiskModule,
    TaxDebtorModule,
    GarovModule,
    SertModule,
    MibModule,
    LargeTaxpayerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
