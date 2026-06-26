import { metrics, type Meter } from '@opentelemetry/api';

export function getMeter(name = 'gmd-seo'): Meter {
  return metrics.getMeter(name);
}
