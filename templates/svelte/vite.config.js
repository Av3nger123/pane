import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// base: './' keeps asset paths relative, so the build works from Pane.
export default defineConfig({ plugins: [svelte()], base: './' });
