/**
 * loaders/db.ts
 *
 * MongoDB Atlas connection via Mongoose.
 * Called once at startup from app.ts AFTER otel is initialized.
 *
 * WHY MongoDB:
 *   - LLM outputs (blog content, SEO analysis, GEO reports) vary in shape
 *   - customerProfile, cmsCredentials, autoBlogConfig are natural documents
 *   - No migrations needed when adding fields during rapid early development
 *   - Horizontal scaling built-in via Atlas sharding
 */

import mongoose from "mongoose";
import { logger } from "../open-tele";

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not defined in environment");

  try {
    await mongoose.connect(uri);
    logger.info("MongoDB connected", { uri: uri.replace(/:\/\/.*@/, "://<redacted>@") });
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)), {
      context: "connectDB",
    });
    process.exit(1);
  }

  mongoose.connection.on("error", (err: Error) => {
    logger.error(err, { context: "mongoose.connection.error" });
  });

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected — Mongoose will attempt reconnect", {
      context: "mongoose.connection.disconnected",
    });
  });

  mongoose.connection.on("reconnected", () => {
    logger.info("MongoDB reconnected", { context: "mongoose.connection.reconnected" });
  });
}
