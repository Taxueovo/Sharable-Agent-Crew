export function requestId(request: Request) {
  return request.headers.get("cf-ray")?.split("-")[0] || crypto.randomUUID();
}

export function audit(event: {
  requestId: string;
  route: string;
  outcome: "ok" | "rejected" | "error";
  startedAt: number;
  teamId?: string;
  turns?: number;
  code?: string;
}) {
  console.info(JSON.stringify({
    event: "arbor_request",
    requestId: event.requestId,
    route: event.route,
    outcome: event.outcome,
    durationMs: Math.max(0, Date.now() - event.startedAt),
    teamId: event.teamId,
    turns: event.turns,
    code: event.code,
  }));
}

export function withRequestId(response: Response, id: string) {
  response.headers.set("x-request-id", id);
  response.headers.set("cache-control", "no-store");
  return response;
}
