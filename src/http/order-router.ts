import { Router } from 'express';

import type { createOrderService } from '../services/order-service.js';
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

  return router;
}
