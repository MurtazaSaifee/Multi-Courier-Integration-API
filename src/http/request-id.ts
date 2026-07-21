import { randomUUID } from 'node:crypto';

import type { Request, RequestHandler, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const incomingRequestId = request.get(REQUEST_ID_HEADER)?.trim();
  const requestId = incomingRequestId || randomUUID();

  response.locals.requestId = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  next();
};

export function getRequestId(request: Request, response: Response): string {
  const requestId = response.locals.requestId ?? request.get(REQUEST_ID_HEADER)?.trim();

  if (requestId) {
    return requestId;
  }

  const generatedRequestId = randomUUID();
  response.locals.requestId = generatedRequestId;
  response.setHeader(REQUEST_ID_HEADER, generatedRequestId);
  return generatedRequestId;
}
