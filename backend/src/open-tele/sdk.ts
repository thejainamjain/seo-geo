import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import config from '@/utils/config';
import { FileLogRecordExporter } from './exporters/file-log';
import { FileSpanExporter } from './exporters/file-span';
import { FileMetricExporter } from './exporters/file-metric';
import { PrettyConsoleLogRecordExporter } from './exporters/pretty-console-log';

const isProd = config.env === 'production';

const logProcessors = [
  new SimpleLogRecordProcessor(new FileLogRecordExporter()),
];

if (!isProd) {
  logProcessors.push(new SimpleLogRecordProcessor(new PrettyConsoleLogRecordExporter()));
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]:      config.service.name,
    [ATTR_SERVICE_VERSION]:   config.service.version,
    'deployment.environment': config.env,
  }),
  spanProcessors: [new SimpleSpanProcessor(new FileSpanExporter())],
  metricReader: new PeriodicExportingMetricReader({
    exporter:             new FileMetricExporter(),
    exportIntervalMillis: 60_000,
  }),
  logRecordProcessors: logProcessors,
});

export function initOtel(): void {
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
  process.on('SIGINT',  () => void sdk.shutdown());
}

export function shutdownOtel(): Promise<void> {
  return sdk.shutdown();
}
