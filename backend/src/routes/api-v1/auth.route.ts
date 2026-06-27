import { Router } from 'express';
import { z } from 'zod';
import { authHandler } from '@/handlers/auth.handler';
import { validate } from '@/middleware/validate';

const router = Router();

const RegisterSchema = z.object({
  name:        z.string().min(1).max(100),
  email:       z.string().email(),
  password:    z.string().min(8).max(100),
  accountType: z.enum(['individual', 'agency']).optional(),
  utmSource:   z.string().optional(),
  utmMedium:   z.string().optional(),
  utmCampaign: z.string().optional(),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

router.post('/register', validate(RegisterSchema), authHandler.register);
router.post('/login',    validate(LoginSchema),    authHandler.login);

export default router;
