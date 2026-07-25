import { Queue } from 'bullmq';
import { ProjectKnowledgeFile, ProjectLearningChunk, Project, OrganizationMember } from '../models';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { uploadToCloudinary, deleteFromCloudinary } from '../lib/cloudinary';
import { getConnectionOptions } from '../loaders/redis';
import { QUEUE_NAMES, JOB_RETRY_CONFIG } from '../constants/seo-pipeline.constants';
import { logger } from '../open-tele';
import type { KnowledgeProcessingJobData } from '../workers/jobs/knowledge-processing.job';

const knowledgeProcessingQueue = new Queue<KnowledgeProcessingJobData>(
  QUEUE_NAMES.KNOWLEDGE_PROCESSING,
  { connection: getConnectionOptions() },
);

const MAX_FILES     = 25;
const MAX_BYTES     = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIMES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
];

async function assertProjectAccess(userId: string, projectId: string) {
  const project = await Project.findById(projectId);
  if (!project) throw new NotFoundError('Project');

  const membership = await OrganizationMember.findOne({
    userId,
    organizationId: project.organizationId,
  });
  if (!membership) throw new ForbiddenError();

  return project;
}

export const knowledgeService = {
  async listFiles(userId: string, projectId: string) {
    logger.debug('knowledgeService.listFiles', { userId, projectId });

    await assertProjectAccess(userId, projectId);

    const files = await ProjectKnowledgeFile.find({ projectId })
      .sort({ createdAt: -1 })
      .lean();

    logger.info('Knowledge files listed', { projectId, count: files.length });
    return files;
  },

  async uploadFile(userId: string, projectId: string, file: Express.Multer.File) {
    logger.debug('knowledgeService.uploadFile', {
      userId,
      projectId,
      filename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    });

    await assertProjectAccess(userId, projectId);

    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      throw new ValidationError(
        `Invalid file type: ${file.mimetype}. Allowed: PDF, text, markdown, CSV, JSON`,
      );
    }

    if (file.size > MAX_BYTES) {
      throw new ValidationError('File exceeds 10MB limit');
    }

    const count = await ProjectKnowledgeFile.countDocuments({ projectId });
    if (count >= MAX_FILES) {
      throw new ValidationError(`Maximum of ${MAX_FILES} knowledge files per project`);
    }

    const { url, publicId } = await uploadToCloudinary(
      file.buffer,
      `${projectId}-${Date.now()}-${file.originalname}`,
      file.mimetype,
    );

    const knowledgeFile = await ProjectKnowledgeFile.create({
      projectId,
      originalName: file.originalname,
      mimeType:     file.mimetype,
      sizeBytes:    file.size,
      storageUrl:   url,
      status:       'pending',
    });

    logger.info('Knowledge file uploaded', {
      projectId,
      fileId:    String(knowledgeFile._id),
      publicId,
      sizeBytes: file.size,
    });

    // Enqueue the extract → classify → chunk → embed pipeline. Previously
    // nothing did this — files were created at status: 'pending' and just
    // stayed there forever. See workers/jobs/knowledge-processing.job.ts.
    await knowledgeProcessingQueue.add(
      'process-knowledge-file',
      { projectId, fileId: String(knowledgeFile._id) },
      {
        attempts: JOB_RETRY_CONFIG.KNOWLEDGE_PROCESSING.attempts,
        backoff:  { type: 'exponential', delay: JOB_RETRY_CONFIG.KNOWLEDGE_PROCESSING.backoffDelay },
      },
    );

    return knowledgeFile;
  },

  async deleteFile(userId: string, projectId: string, fileId: string) {
    logger.debug('knowledgeService.deleteFile', { userId, projectId, fileId });

    await assertProjectAccess(userId, projectId);

    const file = await ProjectKnowledgeFile.findOne({ _id: fileId, projectId });
    if (!file) throw new NotFoundError('KnowledgeFile');

    // Extract publicId from Cloudinary URL
    const urlParts = file.storageUrl.split('/');
    const filename  = urlParts[urlParts.length - 1];
    const folder    = urlParts[urlParts.length - 2];
    const publicId  = `${folder}/${filename.split('.')[0]}`;

    await deleteFromCloudinary(publicId);
    await file.deleteOne();
    // Was previously left behind — orphaned chunks would keep showing up in
    // vector search results (and being embedded in blog prompts) forever
    // after the source file was deleted.
    await ProjectLearningChunk.deleteMany({ fileId, projectId });

    logger.info('Knowledge file deleted', { projectId, fileId });
    return file;
  },
};
