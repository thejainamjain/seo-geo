import type { Request, Response, NextFunction } from 'express';
import { auditService } from '../services/audit.service';

function parsePagination(query: Record<string, unknown>) {
  const page  = Math.max(1, parseInt(String(query['page']  ?? 1), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(query['limit'] ?? 20), 10)));
  return { page, limit };
}

export const auditHandler = {
  async getLatest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const audit = await auditService.getLatestAudit(req.userId, req.params['projectId'] as string);
      res.status(200).json({ audit });
    } catch (err) {
      next(err);
    }
  },

  async listCodeChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);
      const result = await auditService.listCodeChanges(
        req.userId,
        req.params['projectId'] as string,
        {
          type:   req.query['type']   as string | undefined,
          status: req.query['status'] as string | undefined,
          page,
          limit,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async applyCodeChange(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const codeChange = await auditService.applyCodeChange(
        req.userId,
        req.params['projectId'] as string,
        req.params['changeId']  as string,
      );
      res.status(200).json({ codeChange });
    } catch (err) {
      next(err);
    }
  },

  async disableCodeChange(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const codeChange = await auditService.disableCodeChange(
        req.userId,
        req.params['projectId'] as string,
        req.params['changeId']  as string,
      );
      res.status(200).json({ codeChange });
    } catch (err) {
      next(err);
    }
  },

  async listFAQs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);
      const result = await auditService.listFAQs(
        req.userId,
        req.params['projectId'] as string,
        {
          status: req.query['status'] as string | undefined,
          page,
          limit,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async listTLDRs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);
      const result = await auditService.listTLDRs(
        req.userId,
        req.params['projectId'] as string,
        {
          status: req.query['status'] as string | undefined,
          page,
          limit,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
