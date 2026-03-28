import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function hmacSHA256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { user_id } = await req.json();
    if (!user_id) throw new Error("user_id required");

    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: keys } = await supabaseAdmin.from("api_keys").select("mexc_key, mexc_secret").eq("user_id", user_id).maybeSingle();

    if (!keys?.mexc_key || !keys?.mexc_secret) {
      return new Response(JSON.stringify({ success: false, error: "No MEXC API keys found" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const timestamp = Date.now().toString();
    const params = `timestamp=${timestamp}&recvWindow=5000`;
    const signature = await hmacSHA256(keys.mexc_secret, params);

    const res = await fetch(`https://api.mexc.com/api/v3/account?${params}&signature=${signature}`, {
      headers: { "X-MEXC-APIKEY": keys.mexc_key },
    });
    const data = await res.json();

    const success = !data.code;
    return new Response(JSON.stringify({
      success,
      code: data.code,
      msg: data.msg,
      balances: success ? (data.balances || []).filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0).slice(0, 10) : null,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
