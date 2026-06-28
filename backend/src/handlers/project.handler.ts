import type { Request, Response, NextFunction } from 'express';
import { projectService } from '../services/project.service';
import { logger } from '../open-tele';

export const projectHandler = {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await projectService.createProject(req.userId, req.body);
      logger.info('Project created', { projectId: result.project._id.toString() });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const projects = await projectService.listProjects(req.userId);
      res.status(200).json({ projects });
    } catch (err) {
      next(err);
    }
  },

  async getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const project = await projectService.getProject(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json({ project });
    } catch (err) {
      next(err);
    }
  },

  // Legacy
  async updateBusiness(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const project = await projectService.updateBusiness(
        req.userId,
        req.params['projectId'] as string,
        req.body,
      );
      res.status(200).json({ project });
    } catch (err) {
      next(err);
    }
  },

  async getBusinessContext(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const businessContext = await projectService.getBusinessContext(
        req.userId,
        req.params['projectId'] as string,
      );
      // Returns null if not started yet — frontend handles that
      res.status(200).json({ businessContext });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/v1/projects/:projectId/onboarding/step
   * Body: { step: 1|2|3|4|5, data: { ...fields } }
   * Saves one step of the onboarding wizard.
   */
  async saveOnboardingStep(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { step, data } = req.body as {
        step: 1 | 2 | 3 | 4 | 5;
        data: Record<string, unknown>;
      };

      const result = await projectService.saveOnboardingStep(
        req.userId,
        req.params['projectId'] as string,
        step,
        data as never,
      );

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/v1/projects/:projectId/pipeline/start
   * Starts the pipeline after onboarding is complete.
   */
  async startPipeline(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await projectService.startPipeline(
        req.userId,
        req.params['projectId'] as string,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
