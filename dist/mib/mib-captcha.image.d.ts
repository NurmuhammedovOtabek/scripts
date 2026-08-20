export declare function cropFrame(img: any, px?: number): any;
export declare function detectOperator(img: any): '+' | '-' | null;
export declare function readOperator(buffer: Buffer): Promise<'+' | '-' | null>;
