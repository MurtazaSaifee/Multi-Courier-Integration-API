export type RetryOptions = {
  maxRetries: number;
  initialDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return Boolean((error as { retryable: boolean }).retryable);
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, initialDelayMs, sleep = defaultSleep, onRetry } = options;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const delayMs = initialDelayMs * Math.pow(2, attempt);
      if (onRetry) {
        onRetry(error, attempt + 1, delayMs);
      }

      await sleep(delayMs);
      attempt++;
    }
  }
}
