import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { AggregationTemporality, InstrumentType } from '@opentelemetry/sdk-metrics';
import { core } from '@opentelemetry/sdk-node';
import fs from 'fs';
import path from 'path';

export class FileMetricExporter implements PushMetricExporter {
  private getFilePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    const dir = path.join(process.cwd(), 'telemetry', 'metrics');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `metrics-${date}.jsonl`);
  }

  export(metrics: ResourceMetrics, resultCallback: (result: core.ExportResult) => void): void {
    try {
      const lines = metrics.scopeMetrics
        .flatMap((scope) =>
          scope.metrics.map((metric) =>
            JSON.stringify({
              name: metric.descriptor.name,
              description: metric.descriptor.description,
              unit: metric.descriptor.unit,
              valueType: metric.descriptor.valueType,
              dataPointType: metric.dataPointType,
              dataPoints: metric.dataPoints,
              resource: metrics.resource.attributes,
              scope: scope.scope,
            })
          )
        )
        .join('\n');
      if (lines) fs.appendFileSync(this.getFilePath(), lines + '\n');
      resultCallback({ code: core.ExportResultCode.SUCCESS });
    } catch {
      resultCallback({ code: core.ExportResultCode.FAILED });
    }
  }

  selectAggregationTemporality(_instrumentType: InstrumentType): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
