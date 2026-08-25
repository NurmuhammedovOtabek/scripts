"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const log_file_1 = require("./common/log-file");
async function bootstrap() {
    (0, log_file_1.teeConsoleToFile)();
    console.log(`[boot] logging to ${log_file_1.LOG_FILE}`);
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    await app.listen(process.env.PORT ?? 3002);
}
bootstrap();
//# sourceMappingURL=main.js.map