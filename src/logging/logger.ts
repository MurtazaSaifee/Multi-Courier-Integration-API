import { ApplicationError } from '../errors/application-error.js';

export type SafeLogFields = {
  request_id?: string;
  order_id?: string;
  courier_partner?: string;
  error_code?: string;
  error_type?: string;
  attempt?: number;
  stack?: string;
};

type LogLevel = 'info' | 'error';

function writeLog(level: LogLevel, event: string, fields: SafeLogFields = {}): void {
  const entry = {
    level,
    event,
    ...fields
  };

  if (level === 'error') {
    console.error(JSON.stringify(entry));
    return;
  }

  console.log(JSON.stringify(entry));
}

export function logInfo(event: string, fields: SafeLogFields = {}): void {
  writeLog('info', event, fields);
}

function stackWithoutMessage(error: Error): string | undefined {
  return error.stack?.split('\n').slice(1).join('\n');
}

export function logFailure(error: unknown, fields: SafeLogFields = {}): void {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  const errorCode = error instanceof ApplicationError ? error.code : fields.error_code;
  const stack = error instanceof Error && !(error instanceof ApplicationError)
    ? stackWithoutMessage(error)
    : undefined;

  writeLog('error', 'request_failed', {
    ...fields,
    error_code: errorCode,
    error_type: errorType,
    ...(stack ? { stack } : {})
  });
}
