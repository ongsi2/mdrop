import { defineConfig, type Plugin } from 'vite';

/* Locked down to what the page actually needs. `script-src 'self'`
   is the line that matters: even if something slipped past the
   sanitizer, there is no origin it could execute from. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  // `frame-ancestors` is ignored in a meta tag — it ships as a header
  // from vercel.json instead.
  "upgrade-insecure-requests",
].join('; ');

/* Build only — the dev server needs a websocket for HMR, and a
   policy that allowed it would not be the policy we ship. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'mdview:csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [contentSecurityPolicy()],
  build: {
    target: 'es2022',
    cssTarget: 'chrome111',
    rollupOptions: {
      input: {
        main: 'index.html',
        en: 'en/index.html',
        install: 'install/index.html',
        installEn: 'en/install/index.html',
      },
      output: {
        // Keep the first paint tiny: the highlighter is loaded on demand only
        // when a document actually contains a fenced code block.
        manualChunks(id) {
          if (id.includes('highlight.js')) return 'hljs';
        },
      },
    },
  },
});
