import express, { type Express } from 'express';

import { courierRegistry } from './couriers/courier-registry.js';
import { db } from './db/knex.js';
import { createOrderRepository } from './db/repositories/order-repository.js';
import { createTrackingHistoryRepository } from './db/repositories/tracking-history-repository.js';
import { errorHandler } from './http/error-handler.js';
import { createOrderRouter } from './http/order-router.js';
import { requestIdMiddleware } from './http/request-id.js';
import { createOrderService } from './services/order-service.js';

export type AppDependencies = {
  orderService?: ReturnType<typeof createOrderService>;
};

export function createApp(dependencies?: AppDependencies): Express {
  const app = express();

  const orderService = dependencies?.orderService ?? createOrderService(
    createOrderRepository(db),
    createTrackingHistoryRepository(db),
    courierRegistry,
    db
  );

  app.use(requestIdMiddleware);
  app.use(express.json());

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use('/api/v1', createOrderRouter(orderService));

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
