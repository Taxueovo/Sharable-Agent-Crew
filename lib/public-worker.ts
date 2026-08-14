// The single place that names the deployed public worker. A pure constants module:
// it must not import any cloudflare:workers / other lib modules, because it is
// imported from both vite.config.ts (Node context) and app/page.tsx (browser
// context), so it has to stay dependency-free.
// Replace with the URL of your own deployed public worker before use.
export const PUBLIC_BASE_URL = "https://<your-deployed-worker-url>";
