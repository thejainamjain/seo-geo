import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { core } from '@opentelemetry/sdk-node';

const ANSI = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
} as const;

function colorForSeverity(severityNumber?: number): string {
  if (!severityNumber) return ANSI.reset;
  if (severityNumber <= SeverityNumber.DEBUG4) return ANSI.cyan;
  if (severityNumber <= SeverityNumber.INFO4) return ANSI.green;
  if (severityNumber <= SeverityNumber.WARN4) return ANSI.yellow;
  return ANSI.red;
}

function formatTimestamp(hrTime: [number, number]): string {
  return new Date(core.hrTimeToMilliseconds(hrTime))
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '');
}

export class PrettyConsoleLogRecordExporter implements LogRecordExporter {
  export(logs: ReadableLogRecord[], resultCallback: (result: core.ExportResult) => void): void {
    for (const log of logs) {
      const ts = formatTimestamp(log.hrTime);
      const color = colorForSeverity(log.severityNumber);
      const level = `${color}${ANSI.bold}${log.severityText ?? 'LOG'}${ANSI.reset}`;
      const body = typeof log.body === 'object' ? JSON.stringify(log.body) : String(log.body ?? '');

      const attrs = { ...log.attributes };
      const attrStr =
        Object.keys(attrs).length > 0
          ? `\n  ${JSON.stringify(attrs, null, 2).replace(/\n/g, '\n  ')}`
          : '';

      process.stdout.write(`${ts} ${level}: ${body}${attrStr}\n`);
    }
    resultCallback({ code: core.ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
