import { metrics as otelMetrics, type Meter } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

/**
 * The observability port for metrics (ADR-0009): counters and histograms named once, recorded anywhere. Logs and
 * traces are the platform's Pino logger and OpenTelemetry tracing, built in B2.
 */
export interface Counter {
  add(value: number, labels?: Readonly<Record<string, string>>): void;
}

export interface Histogram {
  record(value: number, labels?: Readonly<Record<string, string>>): void;
}

export interface Metrics {
  counter(name: string, description: string): Counter;
  histogram(name: string, description: string, unit: string): Histogram;
  shutdown(): Promise<void>;
}

export const METRICS = Symbol('METRICS');

/**
 * The one metrics adapter: OpenTelemetry with the Prometheus exporter on an internal port (METRICS_PORT, never routed
 * by Caddy; docs/OPERATIONS.md section 3.7). With METRICS_ENABLED=false the same calls go to a meter that records
 * nothing, so code never checks a flag.
 */
export class OtelMetrics implements Metrics {
  private readonly meter: Meter;
  private readonly provider: MeterProvider | undefined;
  readonly exporter: PrometheusExporter | undefined;

  constructor(settings: { readonly enabled: boolean; readonly port: number; readonly serviceName: string }) {
    if (settings.enabled) {
      this.exporter = new PrometheusExporter({ port: settings.port, host: '0.0.0.0', preventServerStart: settings.port === 0 });
      this.provider = new MeterProvider({ readers: [this.exporter] });
      this.meter = this.provider.getMeter(settings.serviceName);
    } else {
      this.meter = otelMetrics.getMeterProvider().getMeter(settings.serviceName);
    }
  }

  counter(name: string, description: string): Counter {
    const counter = this.meter.createCounter(name, { description });
    return { add: (value, labels) => counter.add(value, labels) };
  }

  histogram(name: string, description: string, unit: string): Histogram {
    const histogram = this.meter.createHistogram(name, { description, unit });
    return { record: (value, labels) => histogram.record(value, labels) };
  }

  async shutdown(): Promise<void> {
    await this.provider?.shutdown();
  }
}
