import { AuditLead } from '../models';
import { ValidationError, RateLimitError } from '../utils/errors';
import { logger } from '../open-tele';

// In-memory IP rate limit — one audit per IP per hour
const ipAuditMap = new Map<string, number>();

function sanitizeDomain(raw: string): string {
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .toLowerCase()
    .trim();
}

function checkRateLimit(ip: string): void {
  const last = ipAuditMap.get(ip);
  const now  = Date.now();
  if (last && now - last < 60 * 60 * 1000) {
    throw new RateLimitError('One free audit per IP per hour');
  }
  ipAuditMap.set(ip, now);
}

export const toolsService = {
  async runFreeAudit(ip: string, input: {
    domain:       string;
    email:        string;
    firstName:    string;
    businessType: 'over_150k' | 'under_150k' | 'agency';
  }) {
    logger.debug('toolsService.runFreeAudit', { ip, domain: input.domain });

    checkRateLimit(ip);

    if (!input.domain) throw new ValidationError('domain is required');

    const domain = sanitizeDomain(input.domain);

    const lead = await AuditLead.create({
      websiteUrl:           `https://${domain}`,
      email:                input.email,
      name:                 input.firstName,
      signupQualification:  input.businessType,
    });

    logger.info('AuditLead created', {
      leadId: String(lead._id),
      domain,
      email:  input.email,
    });

    return lead;
  },
};
