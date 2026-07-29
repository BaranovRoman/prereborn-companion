import { Router } from "express";
import { getOverlayController } from "../../controllers/stream/overlay.js";

export const streamOverlayRouter = Router();

streamOverlayRouter.get("/:publicToken", getOverlayController);
