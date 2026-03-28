import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MEXC_FUTURES = "https://contract.mexc.com";

async function hmacSHA256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { user_id } = await req.json();
    if (!user_id) throw new Error("user_id required");

    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: keys } = await supabaseAdmin.from("api_keys").select("mexc_key, mexc_secret, openai_key").eq("user_id", user_id).maybeSingle();

    if (!keys?.mexc_key || !keys?.mexc_secret) {
      return new Response(JSON.stringify({ success: false, error: "No MEXC API keys found" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Test futures account assets
    const timestamp = Date.now().toString();
    const paramStr = `timestamp=${timestamp}`;
    const signature = await hmacSHA256(keys.mexc_secret, paramStr);

    const res = await fetch(`${MEXC_FUTURES}/api/v1/private/account/assets`, {
      method: "GET",
      headers: {
        "ApiKey": keys.mexc_key,
        "Request-Time": timestamp,
        "Signature": signature,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();

    const success = data?.success === true || data?.code === 0;
    const assets = success && Array.isArray(data?.data)
      ? data.data.filter((a: any) => Number(a.availableBalance) > 0 || Number(a.frozenBalance) > 0).slice(0, 10)
      : null;

    return new Response(JSON.stringify({
      success,
      mode: "futures",
      code: data?.code,
      msg: data?.msg,
      assets,
      openai_configured: !!keys.openai_key,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
