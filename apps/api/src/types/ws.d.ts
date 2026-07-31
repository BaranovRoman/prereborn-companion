declare module "ws" {
    export default class WebSocket {
        constructor(url: string);
        send(data: string): void;
        close(): void;
        on(event: "open", listener: () => void): this;
        on(event: "close", listener: () => void): this;
        on(event: "error", listener: (error: unknown) => void): this;
        on(event: "message", listener: (data: { toString(): string }) => void): this;
    }
}
