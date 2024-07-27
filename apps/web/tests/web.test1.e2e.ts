import { test, expect } from '@playwright/test';

test('test1', async ({ page }) => {
  await page.goto('http://localhost:3000/');
  await page.locator('div').filter({ hasText: /^Get started for free$/ }).getByRole('link').click();
  await page.getByPlaceholder('tim@apple.com').click();
  await page.getByRole('button', { name: 'Continue with Email' }).click();
  await page.goto('http://localhost:3000/');
  await page.getByRole('img', { name: 'Landing Page Screenshot Banner' }).click();
  await page.goto('http://localhost:3000/updates');
  await page.getByRole('button', { name: 'Product' }).click();
  await page.goto('http://localhost:3000/login');
});