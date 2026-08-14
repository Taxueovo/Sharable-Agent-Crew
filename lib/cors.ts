/**
 * CORS headers for the sharing API routes.
 *
 * The leader console runs on a local machine (http://localhost:3000, the
 * network-drive delivery) but publishes and manages teams on the deployed
 * Cloudflare worker,
 * so its browser fetches are cross-origin. Every sharing route must echo these
 * headers or the browser will block the console from reading the response.
 *
 * A wildcard origin is safe here: these endpoints are already fully public
 * (anyone with a link + access code can run a team) and no credentials are
 * exchanged, so `Access-Control-Allow-Origin: *` cannot leak anything.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

/** Response for a CORS preflight (OPTIONS) request. */
export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
