import { Router } from "express";
import {
    loginController,
    logoutController,
    refreshController,
    registerController,
} from "../../controllers/stream/auth.js";
import { streamAuthRateLimiter } from "../../middleware/rate-limit.js";

export const streamAuthRouter = Router();

streamAuthRouter.post(
    "/register",
    streamAuthRateLimiter,
    registerController
);
streamAuthRouter.post("/login", streamAuthRateLimiter, loginController);
streamAuthRouter.post("/refresh", refreshController);
streamAuthRouter.post("/logout", logoutController);
