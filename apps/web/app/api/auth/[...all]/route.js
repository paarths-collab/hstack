import { toNextJsHandler } from "better-auth/next-js";
import { getReadyAuth } from "../../../../lib/auth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  return toNextJsHandler(await getReadyAuth()).GET(request);
}

export async function POST(request) {
  return toNextJsHandler(await getReadyAuth()).POST(request);
}
