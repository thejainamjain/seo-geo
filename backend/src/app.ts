import { initOtel, logger } from './open-tele';
initOtel();
import express, { Request, Response, NextFunction } from 'express';
import { connectDB } from './loaders/db';
import { getRedis, closeRedis } from './loaders/redis';
import { errorHandler } from './middleware/error';
import apiV1Routes from './routes/api-v1/index';
import config from '@/utils/config';
import mongoose from 'mongoose';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info('Incoming request', { method: req.method, path: req.path, ip: req.ip });
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v1', apiV1Routes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

app.use(errorHandler);

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received. Shutting down...`);
  await closeRedis();
  await mongoose.connection.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function start(): Promise<void> {
  const PORT = config.port;
  try {
    await connectDB();
    getRedis();
    app.listen(PORT, () => {
      logger.info('Server started', { port: PORT, env: process.env.NODE_ENV ?? 'development' });
    });
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)), { context: 'boot' });
    process.exit(1);
  }
}

start();
export default app;
