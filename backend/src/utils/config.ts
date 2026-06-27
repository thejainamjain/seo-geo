/**
 * utils/config.ts
 *
 * Single source of truth for all environment-derived config.
 * open-tele/sdk.ts imports this — it MUST be resolvable via @/utils/config.
 * Add ONLY values that are read at startup. Runtime secrets (API keys used
 * inside workers) are read directly from process.env at call time so they
 * can be rotated without restart.
 */
import 'dotenv/config';

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const config = {
  env: (process.env.NODE_ENV ?? "development") as "development" | "production" | "test",

  service: {
    name: process.env.SERVICE_NAME ?? "seo-geo-backend",
    version: process.env.SERVICE_VERSION ?? "1.0.0",
  },

  port: Number(process.env.PORT ?? 5000),

  mongo: {
    uri: () => require_env("MONGODB_URI"),
  },

  redis: {
    url: () => require_env("UPSTASH_REDIS_URL"),
  },

  jwt: {
    secret: () => require_env("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  },

  encryption: {
    key: () => require_env("ENCRYPTION_KEY"),
  },

  otel: {
    endpoint:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
  },

  gemini: {
    apiKey: () => require_env("GEMINI_API_KEY"),
  },

  serpapi: {
    apiKey: () => require_env("SERPAPI_KEY"),
  },

  dataforseo: {
    login: () => require_env("DATAFORSEO_LOGIN"),
    password: () => require_env("DATAFORSEO_PASSWORD"),
  },

  cloudinary: {
    cloudName: () => require_env("CLOUDINARY_CLOUD_NAME"),
    apiKey: () => require_env("CLOUDINARY_API_KEY"),
    apiSecret: () => require_env("CLOUDINARY_API_SECRET"),
  },

  google: {
    clientId:     () => require_env('GOOGLE_CLIENT_ID'),
    clientSecret: () => require_env('GOOGLE_CLIENT_SECRET'),
  },

  unsplash: {
    accessKey: () => require_env("UNSPLASH_ACCESS_KEY"),
  },
} as const;

export default config;
