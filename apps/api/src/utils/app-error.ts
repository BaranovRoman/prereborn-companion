export class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;

    constructor(message: string, statusCode: number, code: string) {
        super(message);
        this.name = "AppError";
        this.statusCode = statusCode;
        this.code = code;
    }
}
