/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nitro } from 'nitro/vite';
import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
const dirname = import.meta.dirname;

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
const config = defineConfig({
  resolve: {
    tsconfigPaths: true
  },
  plugins: [devtools(), nitro({
    // Master deploys as a Cloudflare Worker: it needs the dispatch-namespace
    // API, D1 and the R2 image bucket as bindings.
    preset: 'cloudflare-module',
    compatibilityDate: '2025-07-13',
    rollupConfig: {
      external: [/^@sentry\//]
    }
  }), tailwindcss(), tanstackStart(), viteReact()],
  test: {
    projects: [{
      extends: true,
      plugins: [
      // The plugin will run tests for the stories defined in your Storybook config
      // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
      storybookTest({
        configDir: path.join(dirname, '.storybook')
      })],
      test: {
        name: 'storybook',
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({}),
          instances: [{
            browser: 'chromium'
          }]
        }
      }
    }]
  }
});
export default config;