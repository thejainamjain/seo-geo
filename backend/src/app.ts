import { initOtel, logger } from './open-tele';
initOtel();

import express, { Request, Response, NextFunction } from 'express';
import { connectDB } from './loaders/db';
import { getRedis } from './loaders/redis';
import { errorHandler } from './middleware/error';
import apiV1Routes from './routes/api-v1/index';

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
// Routes mounted here as built

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

// MUST be last
app.use(errorHandler);

async function start(): Promise<void> {
  const PORT = process.env.PORT ?? 5000;
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
