import { CaptchaSolverService } from './text_catptcha.service';
export declare class CaptchaController {
    private readonly captchaSolver;
    constructor(captchaSolver: CaptchaSolverService);
    solveCaptcha(tin: string): Promise<{
        success: boolean;
        data: any;
        message: string;
        error?: undefined;
    } | {
        success: boolean;
        error: any;
        data?: undefined;
        message?: undefined;
    }>;
}
