import { corsHeaders, createAdminClient, HttpError, jsonResponse, resolveCaller } from "../_shared/auth.ts";
import { getAccountAssets, MexcAsset, valueMexcPortfolio } from "../_shared/mexc.ts";

interface ProfileRecord {
  demo_mode: boolean;
}

function toNumber(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { isServiceRole, userId: callerUserId } = await resolveCaller(req);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
    const requestedUserId = typeof body.user_id === "string" ? body.user_id : null;

    if (!isServiceRole && requestedUserId && requestedUserId !== callerUserId) {
      throw new HttpError(403, "You can only test your own account");
    }

    const userId = isServiceRole ? requestedUserId : callerUserId;
    if (!userId) {
      throw new HttpError(400, "user_id is required for service-role calls");
    }

    const supabaseAdmin = createAdminClient();
    const { data: keyRow, error: keyError } = await supabaseAdmin
      .from("api_keys")
      .select("mexc_key, mexc_secret, openai_key")
      .eq("user_id", userId)
      .maybeSingle();

    if (keyError) throw keyError;
    if (!keyRow?.mexc_key || !keyRow?.mexc_secret) {
      return jsonResponse({ success: false, error: "No MEXC API keys found" }, { status: 400 });
    }

    const { data: profileRow } = await supabaseAdmin
      .from("profiles")
      .select("demo_mode")
      .eq("user_id", userId)
      .maybeSingle();

    const profile = (profileRow ?? { demo_mode: true }) as ProfileRecord;
    const assetResponse = await getAccountAssets(keyRow.mexc_key, keyRow.mexc_secret);
    const success = assetResponse.success === true || assetResponse.code === 0;
    const assets = success
      ? ((assetResponse.data ?? []) as MexcAsset[])
        .filter((asset) =>
          toNumber(asset.availableBalance) > 0 ||
          toNumber(asset.frozenBalance) > 0 ||
          toNumber(asset.positionMargin) > 0 ||
          toNumber(asset.equity) > 0 ||
          toNumber(asset.unrealized) !== 0
        )
      : [];
    const primaryAsset = assets.find((asset) => asset.currency === "USDT") ?? assets[0] ?? null;
    let portfolioSummary: unknown = null;
    let portfolioAssets: unknown[] = [];
    let portfolioValuationError: string | null = null;

    if (success && assets.length > 0) {
      try {
        const valuation = await valueMexcPortfolio(assets);
        portfolioSummary = valuation.summary;
        portfolioAssets = valuation.assets;
      } catch (error) {
        portfolioValuationError = error instanceof Error ? error.message : String(error);
      }
    }

    return jsonResponse({
      success,
      mode: profile.demo_mode ? "paper" : "live",
      code: assetResponse.code,
      msg: assetResponse.msg ?? assetResponse.message ?? null,
      assets,
      balance_summary: primaryAsset
        ? {
          currency: primaryAsset.currency,
          available: toNumber(primaryAsset.availableBalance),
          frozen: toNumber(primaryAsset.frozenBalance),
          positionMargin: toNumber(primaryAsset.positionMargin),
          cashBalance: toNumber(primaryAsset.cashBalance),
          equity: toNumber(primaryAsset.equity),
          unrealized: toNumber(primaryAsset.unrealized),
          bonus: toNumber(primaryAsset.bonus),
        }
        : null,
      portfolio_summary: portfolioSummary,
      portfolio_assets: portfolioAssets,
      portfolio_valuation_error: portfolioValuationError,
      openai_configured: Boolean(keyRow.openai_key),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ success: false, error: error.message }, { status: error.status });
    }

    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
