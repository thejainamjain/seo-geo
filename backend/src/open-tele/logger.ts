/**
 * open-tele/logger.ts
 *
 * Thin wrapper around the OpenTelemetry Logs API.
 * Emits structured log records that are picked up by the SDK's
 * log record processors (file exporter + pretty console in dev).
 *
 * Usage:
 *   logger.info('User created', { userId: '123' })
 *   logger.error(new Error('Something broke'), { context: 'createUser' })
 *   logger.warn('Retry attempt', { attempt: 2 })
 */

import { logs, SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs';

function emit(
  severityNumber: SeverityNumber,
  severityText:   string,
  message:        string | Error,
  attributes?:    AnyValueMap,
): void {
  const otelLogger = logs.getLogger('seo-geo');

  const body = message instanceof Error ? message.message : message;

  // Merge error stack into attributes if an Error was passed
  const attrs: AnyValueMap = {
    ...(attributes ?? {}),
    ...(message instanceof Error && message.stack
      ? { 'error.stack': message.stack, 'error.type': message.name }
      : {}),
  };

  otelLogger.emit({
    severityNumber,
    severityText,
    body,
    attributes: attrs,
  });
}

export const logger = {
  debug: (msg: string,            attrs?: AnyValueMap) =>
    emit(SeverityNumber.DEBUG, 'DEBUG', msg,     attrs),

  info:  (msg: string,            attrs?: AnyValueMap) =>
    emit(SeverityNumber.INFO,  'INFO',  msg,     attrs),

  warn:  (msg: string,            attrs?: AnyValueMap) =>
    emit(SeverityNumber.WARN,  'WARN',  msg,     attrs),

  error: (msg: string | Error,    attrs?: AnyValueMap) =>
    emit(SeverityNumber.ERROR, 'ERROR', msg,     attrs),
};
