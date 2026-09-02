// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // No UI framework integration: the whole app is Astro templates plus one
  // vanilla-TS client module (src/lib/dapp.ts) talking to viem.
  vite: {
    plugins: [tailwindcss()]
  }
});
