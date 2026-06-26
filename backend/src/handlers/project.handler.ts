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
};
