import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';

describe('Express application', () => {
  it('returns a successful health response', async () => {
    const healthCheck = vi.fn().mockResolvedValue(undefined);
    const response = await request(createApp({ healthCheck })).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(healthCheck).toHaveBeenCalledOnce();
  });

  it('returns a normalized error when the database health check fails', async () => {
    const response = await request(createApp({
      healthCheck: vi.fn().mockRejectedValue(new Error('database unavailable'))
    })).get('/health');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('rejects malformed JSON request bodies', async () => {
    const response = await request(createApp())
      .post('/missing')
      .set('Content-Type', 'application/json')
      .send('{"message":');

    expect(response.status).toBe(400);
  });

  it('returns a JSON not-found response for unknown routes', async () => {
    const response = await request(createApp()).get('/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    });
  });
});
