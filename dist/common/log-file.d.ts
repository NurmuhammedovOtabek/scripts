export declare const LOG_FILE: string;
export declare function teeConsoleToFile(): void;
export declare function redact(text: string): string;
export declare const stripAnsi: (text: string) => string;
export declare function tail(lines: number, filter?: string): {
    lines: string[];
    file: string;
    sizeBytes: number;
};
