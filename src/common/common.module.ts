import { Global, Module } from '@nestjs/common';
import { CaptchaSolverClient } from './captcha-solver.client';
import { MemoryCacheService } from './memory-cache.service';
import { NoProxyPool } from './no-proxy.pool';
import { HtmlParserService } from '../html-parser/html-parser.service';

/**
 * Global so the scrapers can inject the captcha solver without each module
 * re-declaring it — the solver holds one long-lived Python process and must
 * stay a single instance.
 */
@Global()
@Module({
  providers: [CaptchaSolverClient, MemoryCacheService, NoProxyPool, HtmlParserService],
  exports: [CaptchaSolverClient, MemoryCacheService, NoProxyPool, HtmlParserService],
})
export class CommonModule {}
