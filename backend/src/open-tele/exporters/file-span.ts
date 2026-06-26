import * as fs from 'fs';
import * as path from 'path';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-node';

const LOG_DIR  = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'spans.jsonl');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

export class FileSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      const lines = spans.map((span) => {
        const ctx = span.spanContext();
        return JSON.stringify({
          traceId:    ctx.traceId,
          spanId:     ctx.spanId,
          parentSpanId: (span as unknown as { parentSpanId?: string }).parentSpanId ?? null,
          name:       span.name,
          kind:       span.kind,
          startTime:  span.startTime,
          endTime:    span.endTime,
          status:     span.status,
          attributes: span.attributes,
          events:     span.events,
        });
      });

      fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf8');
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({
        code:  ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
