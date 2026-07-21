import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';

describe('Express application', () => {
  it('returns a successful health response', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
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
