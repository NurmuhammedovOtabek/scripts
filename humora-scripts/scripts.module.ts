import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MysoliqModule } from '../mysoliq/mysoliq.module';
import { YattCrawlService } from './yatt-crawl/yatt-crawl.service';
import { YattCrawlController } from './yatt-crawl/yatt-crawl.controller';
import { YattScanService } from './yatt-scan/yatt-scan.service';
import { YattScanController } from './yatt-scan/yatt-scan.controller';
import { S3Module } from '../s3/s3.module';
import { RemoteScraperModule } from './remote-scraper/remote-scraper.module';
import { UserModule } from '../user/user.module';

// Existing scrapers
import { StatRegistryService } from './stat-registry/stat-registry.service';
import { StatQueueService } from './stat-registry/stat-queue.service';
import { StatProcessor } from './stat-registry/stat.processor';
import { STAT_QUEUE } from './stat-registry/stat-queue.constants';
import { BullModule } from '@nestjs/bullmq';
import { ChamberScriptService } from './chamber/chamber.service';
import { NdsScriptService } from './nds/nds.service';
import { CourtCasesScriptService } from './court-cases/court-cases.service';
import { ProxyPoolService } from './proxy/proxy-pool.service';
import { ProcurementScriptService } from './procurement/procurement.service';
import { AuctionScriptService } from './auction/auction.service';
import { AuctionSyncService } from './auction/auction-sync.service';
import { AuctionController } from './auction/auction.controller';
import { ProcurementDocumentsService } from './procurement/procurement-documents.service';
import { MibScriptService } from './mib/mib.service';
import { SertScriptService } from './sert/sert.service';
import { BankScriptService } from './bank/bank.service';
import { ItparkScriptService } from './itpark/itpark.service';

// Fill (batch) services
import { TelegramAlertService } from './common/telegram-alert.service';
import { ChamberFillService } from './chamber/chamber-fill.service';
import { SertFillService } from './sert/sert-fill.service';
import { BranchFillService } from './branch/branch-fill.service';
import { CbuAuthService } from './cbu-sync/cbu-auth.service';
import { CbuApiService } from './cbu-sync/cbu-api.service';
import { CbuFillService } from './cbu-sync/cbu-fill.service';
// New scrapers (migrated from separate `script/` service)
import { CaptchaSolverClient } from './common/captcha-solver.client';
import { HtmlParserService } from './html-parser/html-parser.service';
import { TaxRiskService } from './tax-risk/tax-risk.service';
import { DebtFillService } from './debt-fill/debt-fill.service';
import { TaxDebtorService } from './tax-debtor/tax-debtor.service';
import { TaxDebtorCronService } from './tax-debtor/tax-debtor-cron.service';
import { LargeTaxpayerService } from './large-taxpayer/large-taxpayer.service';
import { BadSuppliersService } from './bad-suppliers/bad-suppliers.service';
import { DavreestrService } from './davreestr/davreestr.service';
import { StateAssetsService } from './state-assets/state-assets.service';
import { ConstructionRatingService } from './construction-rating/construction-rating.service';
import { VendorRatingService } from './vendor-rating/vendor-rating.service';
import { VendorRatingCronService } from './vendor-rating/vendor-rating.cron';
import { StateParticipationService } from './state-participation/state-participation.service';
import { CourtDocumentsSyncService } from './court-documents/court-documents-sync.service';
import { GarovService } from './garov/garov.service';
import { BankRegistrySyncService } from './bank-registry/bank-registry-sync.service';
import { NsSoatoMapSyncService } from './ns-soato-map/ns-soato-map-sync.service';
import { OkedSyncService } from './oked-sync/oked-sync.service';
import { AccreditationSyncService } from './accreditation/accreditation-sync.service';
import { RegistriesSyncService } from './registries/registries-sync.service';
import { OpeninfoClient } from './openinfo/openinfo-client';
import { OpeninfoSyncService } from './openinfo/openinfo-sync.service';
import { SoatoSeedService } from './soato/soato-seed.service';
import { PostcodeSeedService } from './postcode/postcode-seed.service';
import { PostcodeWatchService } from './postcode/postcode-watch.service';
import { MibRegistryService } from './mib-registry/mib-registry.service';
import { MibRegistryCronService } from './mib-registry/mib-registry-cron.service';
import { BirdarchaService } from './birdarcha/birdarcha.service';
import { EjarimaService } from './ejarima/ejarima.service';
import { NewCompanyScanService } from './new-company-scan/new-company-scan.service';
import { NewCompanyBackfillService } from './new-company-scan/new-company-backfill.service';
import { ContactFillService } from './contact-fill/contact-fill.service';
import { CompanyMahallaService } from './company-mahalla/company-mahalla.service';
import { JobControlService } from './job-control/job-control.service';

// Controllers for the new scrapers (useful for standalone testing)
import { TaxRiskController } from './tax-risk/tax-risk.controller';
import { TaxDebtorController } from './tax-debtor/tax-debtor.controller';
import { LargeTaxpayerController } from './large-taxpayer/large-taxpayer.controller';
import { BadSuppliersController } from './bad-suppliers/bad-suppliers.controller';
import { DavreestrController } from './davreestr/davreestr.controller';
import { StateAssetsController } from './state-assets/state-assets.controller';
import { ConstructionRatingController } from './construction-rating/construction-rating.controller';
import { VendorRatingController } from './vendor-rating/vendor-rating.controller';
import { GarovController } from './garov/garov.controller';
import { BankRegistrySyncController } from './bank-registry/bank-registry-sync.controller';
import { NsSoatoMapSyncController } from './ns-soato-map/ns-soato-map-sync.controller';
import { OkedSyncController } from './oked-sync/oked-sync.controller';
import { AccreditationSyncController } from './accreditation/accreditation-sync.controller';
import { RegistriesSyncController } from './registries/registries-sync.controller';
import { OpeninfoSyncController } from './openinfo/openinfo-sync.controller';
import { SoatoSeedController } from './soato/soato-seed.controller';
import { PostcodeController } from './postcode/postcode.controller';
import { MibRegistryController } from './mib-registry/mib-registry.controller';
import { BirdarchaController } from './birdarcha/birdarcha.controller';
import { NewCompanyScanController } from './new-company-scan/new-company-scan.controller';
import { ContactFillController } from './contact-fill/contact-fill.controller';
import { CompanyMahallaController } from './company-mahalla/company-mahalla.controller';
import { JobControlController } from './job-control/job-control.controller';

const services = [
  // Fill services
  TelegramAlertService,
  ChamberFillService,
  SertFillService,
  BranchFillService,
  CbuAuthService,
  CbuApiService,
  CbuFillService,
  // Scrapers
  StatRegistryService,
  StatQueueService,
  StatProcessor,
  ChamberScriptService,
  NdsScriptService,
  CourtCasesScriptService,
  ProxyPoolService,
  ProcurementScriptService,
  ProcurementDocumentsService,
  AuctionScriptService,
  AuctionSyncService,
  MibScriptService,
  SertScriptService,
  BankScriptService,
  ItparkScriptService,
  CaptchaSolverClient,
  HtmlParserService,
  TaxRiskService,
  TaxDebtorService,
  DebtFillService,
  TaxDebtorCronService,
  LargeTaxpayerService,
  BadSuppliersService,
  DavreestrService,
  StateAssetsService,
  ConstructionRatingService,
  VendorRatingService,
  VendorRatingCronService,
  StateParticipationService,
  CourtDocumentsSyncService,
  GarovService,
  BankRegistrySyncService,
  NsSoatoMapSyncService,
  OkedSyncService,
  AccreditationSyncService,
  RegistriesSyncService,
  OpeninfoClient,
  OpeninfoSyncService,
  SoatoSeedService,
  PostcodeSeedService,
  PostcodeWatchService,
  MibRegistryService,
  MibRegistryCronService,
  BirdarchaService,
  EjarimaService,
  NewCompanyScanService,
  NewCompanyBackfillService,
  YattCrawlService,
  YattScanService,
  ContactFillService,
  CompanyMahallaService,
  JobControlService,
];

@Global()
@Module({
  imports: [
    HttpModule.register({ timeout: 30000 }),
    MysoliqModule,
    S3Module,
    BullModule.registerQueue({ name: STAT_QUEUE }),
    // BirdarchaService asks the scraper box for a trader's record, and
    // EjarimaService asks it for a person's penalties; RemoteScraperService is
    // only exported from its own module — without this import Nest cannot
    // resolve it and the app refuses to boot.
    RemoteScraperModule,
    // UserQuotaGuard on the construction and vendor rating reads the company
    // page calls (the site account limits, docs/USER_LIMITS.md).
    UserModule,
  ],
  providers: [...services],
  controllers: [
    AuctionController,
    TaxRiskController,
    TaxDebtorController,
    LargeTaxpayerController,
    BadSuppliersController,
    DavreestrController,
    StateAssetsController,
    ConstructionRatingController,
    VendorRatingController,
    GarovController,
    BankRegistrySyncController,
    NsSoatoMapSyncController,
    OkedSyncController,
    AccreditationSyncController,
    RegistriesSyncController,
    OpeninfoSyncController,
    SoatoSeedController,
    PostcodeController,
    MibRegistryController,
    BirdarchaController,
    NewCompanyScanController,
    YattCrawlController,
    YattScanController,
    ContactFillController,
    CompanyMahallaController,
    JobControlController,
  ],
  exports: services,
})
export class ScriptsModule {}
