/**
 * app.ts — Server entry point
 *
 * BOOT ORDER — non-negotiable:
 *   1. open-tele/sdk  → must instrument modules BEFORE they are required
 *   2. logger         → used by everything below
 *   3. connectDB      → Mongoose models registered
 *   4. getRedis       → BullMQ connection ready
 *   5. Express app    → routes, middleware
 *
 * DO NOT import any service, model, or worker before step 1.
 */

// ── Step 1: OpenTelemetry MUST be first ───────────────────────────────────
import { initOtel, logger } from "./open-tele";
initOtel();

// ── Step 2: Everything else ───────────────────────────────────────────────
import express, { Request, Response, NextFunction } from "express";
import { connectDB } from "./loaders/db";
import { getRedis } from "./loaders/redis";

// Routes — uncomment as you build them
// import authRoutes    from "./routes/api-v1/auth";
// import projectRoutes from "./routes/api-v1/project";
// import seoRoutes     from "./routes/api-v1/seo";

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logger — logs every inbound HTTP request
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info("Incoming request", {
    method: req.method,
    path:   req.path,
    ip:     req.ip,
  });
  next();
});

// ── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── API Routes ─────────────────────────────────────────────────────────────
// app.use("/api/v1/auth",     authRoutes);
// app.use("/api/v1/projects", projectRoutes);
// app.use("/api/v1/seo",      seoRoutes);

// ── 404 handler ────────────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
  logger.warn("Route not found", { method: req.method, path: req.path });
  res.status(404).json({ error: "Route not found" });
});

// ── Global error handler ───────────────────────────────────────────────────
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error(err, {
    context: "global_error_handler",
    method:  req.method,
    path:    req.path,
  });
  res.status(500).json({ error: "Internal server error" });
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  const PORT = process.env.PORT ?? 5000;

  try {
    await connectDB();
    getRedis();

    app.listen(PORT, () => {
      logger.info("Server started", {
        port: PORT,
        env:  process.env.NODE_ENV ?? "development",
      });
    });
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)), {
      context: "boot",
    });
    process.exit(1);
  }
}

start();

export default app;
