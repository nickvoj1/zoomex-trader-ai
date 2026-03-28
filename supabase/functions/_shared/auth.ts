import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function getEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function createAdminClient() {
  return createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

function createUserClient(authHeader: string) {
  return createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_ANON_KEY"), {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return atob(normalized + padding);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    return JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAuthorizationHeader(req: Request): string {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Authorization header is required");
  }
  return authHeader;
}

export function isServiceRoleToken(token: string): boolean {
  const payload = decodeJwtPayload(token);
  return payload?.role === "service_role";
}

export async function resolveCaller(req: Request): Promise<{
  authHeader: string;
  isServiceRole: boolean;
  userId: string | null;
}> {
  const authHeader = getAuthorizationHeader(req);
  const token = authHeader.slice("Bearer ".length);

  if (isServiceRoleToken(token)) {
    return { authHeader, isServiceRole: true, userId: null };
  }

  const supabaseUser = createUserClient(authHeader);
  const { data, error } = await supabaseUser.auth.getUser();

  if (error || !data.user) {
    throw new HttpError(401, "Invalid user token");
  }

  return { authHeader, isServiceRole: false, userId: data.user.id };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
