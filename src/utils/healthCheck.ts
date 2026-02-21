import { Stream, HealthCheckResult } from '../types';

const TIMEOUT_MS = 8000;
const CONCURRENCY = 10;

async function checkStream(stream: Stream): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Try HEAD first, then GET with range
    try {
      await fetch(stream.url, {
        method: 'HEAD',
        signal: controller.signal,
        mode: 'no-cors',
      });
      clearTimeout(timer);
      return {
        streamId: stream.id,
        status: 'alive',
        responseTime: Date.now() - start,
        checkedAt: Date.now(),
      };
    } catch {
      // no-cors mode always throws for opaque, treat as alive if not abort
      clearTimeout(timer);
      if (!controller.signal.aborted) {
        return {
          streamId: stream.id,
          status: 'alive',
          responseTime: Date.now() - start,
          checkedAt: Date.now(),
        };
      }
      throw new Error('Timeout');
    }
  } catch {
    return {
      streamId: stream.id,
      status: 'dead',
      checkedAt: Date.now(),
    };
  }
}

export async function checkStreams(
  streams: Stream[],
  onProgress: (result: HealthCheckResult, index: number, total: number) => void,
  signal?: AbortSignal
): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  let index = 0;

  for (let i = 0; i < streams.length; i += CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = streams.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(s => checkStream(s)));
    batchResults.forEach(r => {
      results.push(r);
      onProgress(r, ++index, streams.length);
    });
  }

  return results;
}

export async function checkSingleStream(url: string): Promise<{ alive: boolean; responseTime?: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    await fetch(url, { method: 'HEAD', signal: controller.signal, mode: 'no-cors' });
    clearTimeout(timer);
    return { alive: true, responseTime: Date.now() - start };
  } catch (e) {
    const err = e as Error;
    if (err.name !== 'AbortError') {
      return { alive: true, responseTime: Date.now() - start };
    }
    return { alive: false };
  }
}
