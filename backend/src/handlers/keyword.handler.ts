import type { Request, Response, NextFunction } from 'express';
import { keywordService } from '../services/keyword.service';

function parsePagination(query: Record<string, unknown>) {
  const page  = Math.max(1, parseInt(String(query['page']  ?? 1), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(query['limit'] ?? 20), 10)));
  return { page, limit };
}

export const keywordHandler = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);
      const weekNumber = req.query['weekNumber']
        ? parseInt(String(req.query['weekNumber']), 10)
        : undefined;

      const result = await keywordService.listKeywords(
        req.userId,
        req.params['projectId'] as string,
        {
          status: req.query['status'] as string | undefined,
          weekNumber,
          page,
          limit,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async add(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const keyword = await keywordService.addKeyword(
        req.userId,
        req.params['projectId'] as string,
        req.body,
      );
      res.status(201).json({ keyword });
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const keyword = await keywordService.deleteKeyword(
        req.userId,
        req.params['projectId'] as string,
        req.params['keywordId'] as string,
      );
      res.status(200).json({ keyword });
    } catch (err) {
      next(err);
    }
  },
};
