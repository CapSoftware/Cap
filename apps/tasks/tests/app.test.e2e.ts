import { test, expect, request } from '@playwright/test';

test.describe('API Endpoints', () => {
  let apiContext:any;

  test.beforeAll(async ({ playwright }) => {
    apiContext = await playwright.request.newContext({
      baseURL: 'http://localhost:3002',
    });
  });

  test.afterAll(async () => {
    await apiContext.dispose();
  });

  test('responds with a not found message for unknown route', async () => {
    const response = await apiContext.get('/what-is-this-even', {
      headers: {
        Accept: 'application/json',
      },
    });

    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toContain('application/json');
  });

  test('responds with a json message at root', async () => {
    const response = await apiContext.get('/', {
      headers: {
        Accept: 'application/json',
      },
    });

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');

    const responseBody = await response.json();
    expect(responseBody).toEqual({ message: 'OK' });
  });
});
