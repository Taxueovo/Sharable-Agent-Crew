import { env } from "cloudflare:workers";

export async function GET() {
  return Response.json({ vision: String(env.OPENAI_VISION_ENABLED ?? "true").toLowerCase() !== "false" });
}
