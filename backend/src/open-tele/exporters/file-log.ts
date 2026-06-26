import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { core } from '@opentelemetry/sdk-node';
import fs from 'fs';
import path from 'path';

export class FileLogRecordExporter implements LogRecordExporter {
  private getFilePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    const dir = path.join(process.cwd(), 'telemetry', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `logs-${date}.jsonl`);
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: core.ExportResult) => void): void {
    try {
      const lines = logs
        .map((log) =>
          JSON.stringify({
            timestamp: new Date(core.hrTimeToMilliseconds(log.hrTime)).toISOString(),
            severityText: log.severityText,
            severityNumber: log.severityNumber,
            body: log.body,
            attributes: log.attributes,
            resource: log.resource.attributes,
            traceId: log.spanContext?.traceId,
            spanId: log.spanContext?.spanId,
          })
        )
        .join('\n');
      if (lines) fs.appendFileSync(this.getFilePath(), lines + '\n');
      resultCallback({ code: core.ExportResultCode.SUCCESS });
    } catch {
      resultCallback({ code: core.ExportResultCode.FAILED });
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
