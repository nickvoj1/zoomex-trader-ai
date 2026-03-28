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

    const { data: keys } = await supabaseAdmin.from("api_keys").select("zoomex_key, zoomex_secret").eq("user_id", user_id).maybeSingle();

    if (!keys?.zoomex_key || !keys?.zoomex_secret) {
      return new Response(JSON.stringify({ success: false, error: "No Zoomex API keys found" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Test: get wallet balance
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const params = "accountType=UNIFIED";
    const preSign = `${timestamp}${keys.zoomex_key}${recvWindow}${params}`;
    const signature = await hmacSHA256(keys.zoomex_secret, preSign);

    const res = await fetch(`https://api.zoomex.com/cloud/trade/v3/account/wallet-balance?${params}`, {
      headers: {
        "X-BAPI-API-KEY": keys.zoomex_key,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });
    const data = await res.json();

    const success = data.retCode === 0;
    return new Response(JSON.stringify({
      success,
      retCode: data.retCode,
      retMsg: data.retMsg,
      balance: success ? data.result?.list?.[0]?.totalEquity : null,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
