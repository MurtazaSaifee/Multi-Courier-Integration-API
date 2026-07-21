import { Router } from 'express';

import type { createOrderService } from '../services/order-service.js';
import { ValidationError } from '../errors/application-error.js';
import { createOrderRequestSchema } from './schemas.js';
import { validateBody } from './validation.js';

export function createOrderRouter(
  orderService: ReturnType<typeof createOrderService>
): Router {
  const router = Router();

  router.post(
    '/orders',
    validateBody(createOrderRequestSchema),
    async (request, response, next) => {
      try {
        const result = await orderService.createOrder(request.body);
        response.status(201).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get('/orders/:order_id/track', async (request, response, next) => {
    try {
      const orderId = String(request.params.order_id || '').trim();
      if (!orderId) {
        throw new ValidationError([
          { field: 'order_id', message: 'Order ID is required' }
        ]);
      }
      const result = await orderService.trackOrder(orderId);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/orders/:order_id/cancel', async (request, response, next) => {
    try {
      const orderId = String(request.params.order_id || '').trim();
      if (!orderId) {
        throw new ValidationError([
          { field: 'order_id', message: 'Order ID is required' }
        ]);
      }
      const result = await orderService.cancelOrder(orderId);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
