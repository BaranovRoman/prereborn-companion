declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      streamUserId?: string;
    }
  }
}

export {};
