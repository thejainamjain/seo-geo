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
 *
 * WHY getConnectionOptions() is separate from getRedis():
 *   - BullMQ Worker/Queue need raw connection options, NOT a Redis instance
 *   - Passing a Redis instance to BullMQ causes duplicate connection issues
 *   - getRedis() is for direct Redis operations (health checks, manual get/set)
 *   - getConnectionOptions() is for BullMQ — it creates its own managed connections
 */
import { Redis, type RedisOptions } from 'ioredis';
import config from '../utils/config';
import { logger } from '../open-tele';

let redisClient: Redis | null = null;

/**
 * Returns raw ioredis connection options for BullMQ.
 * BullMQ creates and manages its own Redis connections internally —
 * never pass a Redis instance directly to BullMQ Queue or Worker.
 */
export function getConnectionOptions(): RedisOptions {
  const url = config.redis.url();
  const isTls  = url.startsWith('rediss://');
  const parsed = new URL(url);

  return {
    host:                 parsed.hostname,
    port:                 parsed.port ? parseInt(parsed.port, 10) : (isTls ? 6380 : 6379),
    password:             parsed.password || undefined,
    tls:                  isTls ? {} : undefined,
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck:     false,  // required by BullMQ with Upstash
  };
}

/**
 * Returns a singleton Redis instance for direct Redis operations.
 * Do NOT pass this to BullMQ — use getConnectionOptions() for that.
 */
export function getRedis(): Redis {
  if (!redisClient) {
    const url = config.redis.url();
    if (!url) throw new Error('UPSTASH_REDIS_URL is not defined');

    redisClient = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
      tls: url.startsWith('rediss://') ? {} : undefined,
    });

    redisClient.on('connect',      () => logger.info('Redis connected',     { context: 'redis' }));
    redisClient.on('ready',        () => logger.info('Redis ready',         { context: 'redis' }));
    redisClient.on('error',   (err) => logger.error(err,                    { context: 'redis.error' }));
    redisClient.on('close',        () => logger.warn('Redis closed',        { context: 'redis' }));
    redisClient.on('reconnecting', () => logger.info('Redis reconnecting',  { context: 'redis' }));
  }
  return redisClient;
}

/**
 * Gracefully closes the Redis connection.
 * Called during worker/app shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed', { context: 'redis' });
  }
}
