/**
 * CORS headers for the sharing API routes.
 *
 * The leader console runs on a local machine (http://localhost:3000, the
 * network-drive delivery) but publishes and manages teams on the deployed
 * Cloudflare worker,
 * so its browser fetches are cross-origin. Every sharing route must echo these
 * headers or the browser will block the console from reading the response.
 *
 * Publishing and management are relayed server-to-server by the local console.
 * They deliberately do not advertise a cross-origin browser permission.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-arbor-publish-token",
    "cache-control": "no-store",
  };
}

/** Response for a CORS preflight (OPTIONS) request. */
export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
