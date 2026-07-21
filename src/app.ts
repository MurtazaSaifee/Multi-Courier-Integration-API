import express, { type Express } from 'express';

import { errorHandler } from './http/error-handler.js';
import { requestIdMiddleware } from './http/request-id.js';

export function createApp(): Express {
  const app = express();

  app.use(requestIdMiddleware);
  app.use(express.json());

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    });
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
