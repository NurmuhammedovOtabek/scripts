import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LOG_FILE, teeConsoleToFile } from './common/log-file';

async function bootstrap() {
  // Before the app exists, so its own start-up lines land in the file too — a
  // box that fails to boot is exactly when the log is needed most.
  teeConsoleToFile();
  console.log(`[boot] logging to ${LOG_FILE}`);

  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3002);
}
bootstrap();
