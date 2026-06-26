/**
 * loaders/redis.ts
 *
 * Redis connection via ioredis, used by BullMQ for job queues.
 * Upstash Redis in production (serverless-friendly, free tier available).
 *
 * WHY BullMQ + Redis:
 *   - Crawling, LLM calls, and CMS publishing are async background jobs
 *   - They can fail and need automatic retry with exponential backoff
 *   - BullMQ gives retry logic, job progress tracking, delayed jobs, and cron
 *   - Upstash Redis is persistent and has built-in TLS — no Redis server to manage
 */

import { Redis } from "ioredis";
import { logger } from "../open-tele";

let redisClient: Redis;

export function getRedis(): Redis {
  if (!redisClient) {
    const url = process.env.UPSTASH_REDIS_URL;
    if (!url) throw new Error("UPSTASH_REDIS_URL is not defined in environment");

    redisClient = new Redis(url, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck:    false, // Required by BullMQ with Upstash
      tls: url.startsWith("rediss://") ? {} : undefined,
    });

    redisClient.on("connect", () => {
      logger.info("Redis connected", { context: "redis.connect" });
    });

    redisClient.on("ready", () => {
      logger.info("Redis ready", { context: "redis.ready" });
    });

    redisClient.on("error", (err: Error) => {
      logger.error(err, { context: "redis.error" });
    });

    redisClient.on("close", () => {
      logger.warn("Redis connection closed", { context: "redis.close" });
    });

    redisClient.on("reconnecting", () => {
      logger.info("Redis reconnecting...", { context: "redis.reconnecting" });
    });
  }

  return redisClient;
}
