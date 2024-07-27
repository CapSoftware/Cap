import type { PlaywrightTestConfig } from '@playwright/test';
import { devices } from '@playwright/test';
import dotenv from 'dotenv';
import * as os from 'os';
import * as path from 'path';

dotenv.config({ path: '.env' });

const outputDir = path.join(__dirname, 'test-results');

const DEFAULT_NAVIGATION_TIMEOUT = 120000;
const DEFAULT_EXPECT_TIMEOUT = 120000;
const DEFAULT_TEST_TIMEOUT = 240000;

const headless = true; 

const webServer = [
  {
    command: 'pnpm run dev',
    port: 3000,
    timeout: 60000,
    reuseExistingServer: true,
  },
  {
    command: 'pnpm run dev',
    port: 3002,
    timeout: 60000,
    reuseExistingServer: true,
  },
  {
    command: 'pnpm run dev',
    port: 3003,
    timeout: 60000,
    reuseExistingServer: true,
  },
];

const DEFAULT_CHROMIUM = {
  ...devices['Desktop Chrome'],
  timezoneId: 'Europe/London',
  locale: 'en-US',
  navigationTimeout: DEFAULT_NAVIGATION_TIMEOUT,
};

const config: PlaywrightTestConfig = {
  forbidOnly: false,
  retries: 2,
  workers: os.cpus().length,
  timeout: DEFAULT_TEST_TIMEOUT,
  maxFailures: 5,
  fullyParallel: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: './test-results/reports/playwright-html-report', open: 'never' }],
    ['junit', { outputFile: './test-results/reports/results.xml' }],
  ],
  outputDir: path.join(outputDir, 'results'),
  webServer,
  use: {
    baseURL: process.env.NEXT_PUBLIC_URL || 'http://localhost:3000',
    locale: 'en-US',
    trace: 'retain-on-failure',
    headless,
    contextOptions: {
      permissions: ['clipboard-read', 'clipboard-write'],
    },
  },
  projects: [
    {
      name: 'web',
      testDir: './apps/web/tests',
      testMatch: /.*\.e2e\.tsx?/,
      use: DEFAULT_CHROMIUM,
    },
    {
      name: 'desktop',
      testDir: './apps/desktop/tests',
      testMatch: /.*\.e2e\.tsx?/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3003/',
      },
    },
    {
      name: 'tasks',
      testDir: './apps/tasks/tests',
      testMatch: /.*\.e2e\.tsx?/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3002/',
      },
    },
    {
      name: 'packages-ui',
      testDir: './packages/ui/tests',
      testMatch: /.*\.e2e\.tsx?/,
      use: DEFAULT_CHROMIUM,
    },
    {
      name: 'packages-utils',
      testDir: './packages/utils/tests',
      testMatch: /.*\.e2e\.tsx?/,
      use: DEFAULT_CHROMIUM,
    },
    {
      name: 'packages-database-config',
      testDir: './packages/database-config/tests',
      testMatch: /.*\.e2e\.tsx?/,
      use: DEFAULT_CHROMIUM,
    },
  ],
};

export default config;
