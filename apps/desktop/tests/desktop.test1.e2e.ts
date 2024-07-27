import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:3001/');
  await page.getByRole('button', { name: 'Full screen' }).click();
  await page.getByRole('button', { name: 'Video On' }).click();
  await page.getByRole('button', { name: 'Mic On' }).click();
  await page.getByRole('button', { name: 'Start Recording' }).click();
  await page.getByRole('button', { name: 'Stop - 0:' }).click();
  await page.getByRole('button', { name: 'Video On' }).click();
  
});