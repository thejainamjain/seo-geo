import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User, Organization, OrganizationMember } from '../models';
import { signToken } from '../utils/jwt';
import { ConflictError, UnauthorizedError } from '../utils/errors';
import { logger } from '../open-tele';

interface RegisterInput {
  name:         string;
  email:        string;
  password:     string;
  accountType?: 'individual' | 'agency';
  utmSource?:   string;
  utmMedium?:   string;
  utmCampaign?: string;
}

interface LoginInput {
  email:    string;
  password: string;
}

interface AuthResult {
  token: string;
  user: {
    id:             string;
    name:           string;
    email:          string;
    accountType:    string;
    organizationId: string;
  };
}

export const authService = {
  async register(input: RegisterInput): Promise<AuthResult> {
    logger.debug('authService.register', { email: input.email });

    const existing = await User.findOne({ email: input.email.toLowerCase() });
    if (existing) throw new ConflictError('Email');

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const passwordHash = await bcrypt.hash(input.password, 12);

      const [user] = await User.create([{
        name:        input.name,
        email:       input.email.toLowerCase(),
        passwordHash,
        accountType: input.accountType ?? 'individual',
        utmSource:   input.utmSource,
        utmMedium:   input.utmMedium,
        utmCampaign: input.utmCampaign,
      }], { session });

      const [org] = await Organization.create([{
        name: input.name,
        type: input.accountType === 'agency' ? 'agency' : 'individual',
      }], { session });

      await OrganizationMember.create([{
        userId:         user._id,
        organizationId: org._id,
        role:           'owner',
      }], { session });

      await session.commitTransaction();

      const token = signToken({ userId: user._id.toString() });

      logger.info('User registered', {
        userId:         user._id.toString(),
        organizationId: org._id.toString(),
      });

      return {
        token,
        user: {
          id:             user._id.toString(),
          name:           user.name,
          email:          user.email,
          accountType:    user.accountType,
          organizationId: org._id.toString(),
        },
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  },

  async login(input: LoginInput): Promise<AuthResult> {
    logger.debug('authService.login', { email: input.email });

    const user = await User.findOne({ email: input.email.toLowerCase() });
    if (!user) throw new UnauthorizedError('Invalid email or password');

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid email or password');

    // Get their org
    const membership = await OrganizationMember.findOne({ userId: user._id });
    if (!membership) throw new UnauthorizedError('No organization found for user');

    const token = signToken({ userId: user._id.toString() });

    logger.info('User logged in', { userId: user._id.toString() });

    return {
      token,
      user: {
        id:             user._id.toString(),
        name:           user.name,
        email:          user.email,
        accountType:    user.accountType,
        organizationId: membership.organizationId.toString(),
      },
    };
  },

  /** Current user for GET /auth/me. Throws 401 if the user no longer exists. */
  async getMe(userId: string): Promise<AuthResult['user']> {
    const user = await User.findById(userId);
    if (!user) throw new UnauthorizedError('User no longer exists');

    const membership = await OrganizationMember.findOne({ userId: user._id });
    if (!membership) throw new UnauthorizedError('No organization found for user');

    return {
      id:             user._id.toString(),
      name:           user.name,
      email:          user.email,
      accountType:    user.accountType,
      organizationId: membership.organizationId.toString(),
    };
  },
};
