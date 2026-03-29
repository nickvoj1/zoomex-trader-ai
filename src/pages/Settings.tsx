import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesUpdate } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { CheckCircle, Eye, EyeOff, Loader2, XCircle } from "lucide-react";

type ApiKeysForm = Pick<
  Tables<"api_keys">,
  "mexc_key" | "mexc_secret" | "coincodex_key" | "openai_key" | "telegram_token"
>;

type ProfileForm = Pick<
  Tables<"profiles">,
  | "auto_trade"
  | "max_risk_pct"
  | "leverage"
  | "demo_mode"
  | "min_confidence"
  | "daily_loss_limit_pct"
  | "max_consecutive_losses"
  | "allow_trend_trades"
  | "allow_mean_reversion_trades"
> & {
  telegram_id: string;
};

interface ConnectionAsset {
  currency: string;
  availableBalance?: number | string;
  frozenBalance?: number | string;
  positionMargin?: number | string;
  equity?: number | string;
  unrealized?: number | string;
}

interface PortfolioSummary {
  currency: "USDT";
  totalUsdt: number;
  availableUsdt: number;
  lockedUsdt: number;
  unrealizedUsdt: number;
  bonusUsdt: number;
  assetCount: number;
  pricedAssetCount: number;
  unpricedAssetCount: number;
  unpricedCurrencies: string[];
  valuationSource: string;
}

interface PortfolioAsset {
  currency: string;
  equity: number;
  available: number;
  locked: number;
  unrealized: number;
  bonus: number;
  usdtPrice: number | null;
  usdtValue: number | null;
  conversionPath: string[] | null;
  priced: boolean;
}

interface ConnectionTestResult {
  success: boolean;
  mode: "paper" | "live";
  code?: number;
  msg?: string | null;
  assets?: ConnectionAsset[];
  portfolio_summary?: PortfolioSummary | null;
  portfolio_assets?: PortfolioAsset[];
  portfolio_valuation_error?: string | null;
  openai_configured?: boolean;
  error?: string;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult | null>(null);

  const [keys, setKeys] = useState<ApiKeysForm>({
    mexc_key: "",
    mexc_secret: "",
    coincodex_key: "",
    openai_key: "",
    telegram_token: "",
  });

  const [profile, setProfile] = useState<ProfileForm>({
    auto_trade: false,
    max_risk_pct: 0.5,
    leverage: 10,
    telegram_id: "",
    demo_mode: true,
    min_confidence: 78,
    daily_loss_limit_pct: 3,
    max_consecutive_losses: 3,
    allow_trend_trades: true,
    allow_mean_reversion_trades: true,
  });

  useEffect(() => {
    if (!user) return;

    const loadSettings = async () => {
      const { data: keyData } = await supabase
        .from("api_keys")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (keyData) {
        setKeys({
          mexc_key: keyData.mexc_key || "",
          mexc_secret: keyData.mexc_secret || "",
          coincodex_key: keyData.coincodex_key || "",
          openai_key: keyData.openai_key || "",
          telegram_token: keyData.telegram_token || "",
        });
      }

      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (profileData) {
        setProfile({
          auto_trade: profileData.auto_trade,
          max_risk_pct: Number(profileData.max_risk_pct),
          leverage: profileData.leverage,
          telegram_id: profileData.telegram_id || "",
          demo_mode: profileData.demo_mode,
          min_confidence: Number(profileData.min_confidence),
          daily_loss_limit_pct: Number(profileData.daily_loss_limit_pct),
          max_consecutive_losses: profileData.max_consecutive_losses,
          allow_trend_trades: profileData.allow_trend_trades,
          allow_mean_reversion_trades: profileData.allow_mean_reversion_trades,
        });
      }
    };

    void loadSettings();
  }, [user]);

  const handleSaveKeys = async () => {
    if (!user) return;

    setSaving(true);
    const { error } = await supabase
      .from("api_keys")
      .upsert({ user_id: user.id, ...keys }, { onConflict: "user_id" });
    setSaving(false);

    if (error) toast.error(error.message);
    else toast.success("API keys saved securely");
  };

  const handleSaveProfile = async () => {
    if (!user) return;

    setSaving(true);
    const profileUpdate: TablesUpdate<"profiles"> = {
      auto_trade: profile.auto_trade,
      max_risk_pct: profile.max_risk_pct,
      leverage: profile.leverage,
      telegram_id: profile.telegram_id || null,
      demo_mode: profile.demo_mode,
      min_confidence: profile.min_confidence,
      daily_loss_limit_pct: profile.daily_loss_limit_pct,
      max_consecutive_losses: profile.max_consecutive_losses,
      allow_trend_trades: profile.allow_trend_trades,
      allow_mean_reversion_trades: profile.allow_mean_reversion_trades,
    };

    const { error } = await supabase
      .from("profiles")
      .update(profileUpdate)
      .eq("user_id", user.id);
    setSaving(false);

    if (error) toast.error(error.message);
    else toast.success("Settings saved");
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setConnectionResult(null);

    try {
      const { data, error } = await supabase.functions.invoke("test-mexc", {
        body: {},
      });
      if (error) throw error;

      const result = data as ConnectionTestResult;
      setConnectionResult(result);

      if (result.success) {
        toast.success("MEXC connection verified");
      } else {
        toast.error(result.msg || result.error || "MEXC connection failed");
      }
    } catch (error) {
      const message = getErrorMessage(error);
      setConnectionResult({ success: false, mode: profile.demo_mode ? "paper" : "live", error: message });
      toast.error("Connection test failed", { description: message });
    } finally {
      setTestingConnection(false);
    }
  };

  const keyFields: Array<{ key: keyof ApiKeysForm; label: string }> = [
    { key: "mexc_key", label: "MEXC API Key" },
    { key: "mexc_secret", label: "MEXC Secret" },
    { key: "coincodex_key", label: "CoinCodex API Key" },
    { key: "openai_key", label: "OpenAI API Key" },
    { key: "telegram_token", label: "Telegram Bot Token" },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6 animate-slide-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage API keys, risk controls, and execution mode</p>
      </div>

      <Card className="glass-card border-border">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">API Keys</CardTitle>
              <CardDescription>Store exchange and model credentials in Supabase</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowSecrets((value) => !value)}>
              {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {keyFields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label className="text-xs">{field.label}</Label>
              <Input
                type={showSecrets ? "text" : "password"}
                value={keys[field.key] || ""}
                onChange={(event) => setKeys({ ...keys, [field.key]: event.target.value })}
                placeholder={`Enter ${field.label.toLowerCase()}`}
                className="font-mono text-sm"
              />
            </div>
          ))}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button onClick={handleSaveKeys} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save API Keys
            </Button>
            <Button variant="outline" onClick={handleTestConnection} disabled={testingConnection}>
              {testingConnection ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Test MEXC Connection
            </Button>
          </div>

          {connectionResult && (
            <div className="rounded-xl border border-border bg-secondary/50 p-4">
              <div className="flex items-center gap-2">
                {connectionResult.success ? (
                  <CheckCircle className="h-4 w-4 text-profit" />
                ) : (
                  <XCircle className="h-4 w-4 text-loss" />
                )}
                <p className="text-sm font-medium">
                  {connectionResult.success ? "Connection verified" : "Connection failed"}
                </p>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Mode: {connectionResult.mode} {connectionResult.code !== undefined ? `· Code ${connectionResult.code}` : ""}
              </p>
              {connectionResult.portfolio_summary && (
                <p className="mt-1 text-xs font-mono text-foreground/80">
                  Portfolio {formatUsd(connectionResult.portfolio_summary.totalUsdt)} · Available{" "}
                  {formatUsd(connectionResult.portfolio_summary.availableUsdt)} · Locked{" "}
                  {formatUsd(connectionResult.portfolio_summary.lockedUsdt)} · Unrealized{" "}
                  {formatUsd(connectionResult.portfolio_summary.unrealizedUsdt)} ·{" "}
                  {connectionResult.portfolio_summary.pricedAssetCount}/{connectionResult.portfolio_summary.assetCount} assets valued
                </p>
              )}
              {(connectionResult.msg || connectionResult.error) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {connectionResult.msg || connectionResult.error}
                </p>
              )}
              {connectionResult.portfolio_valuation_error && (
                <p className="mt-1 text-xs text-warning">
                  Portfolio valuation warning: {connectionResult.portfolio_valuation_error}
                </p>
              )}
              {connectionResult.portfolio_summary?.unpricedCurrencies.length ? (
                <p className="mt-1 text-xs text-warning">
                  Unpriced assets: {connectionResult.portfolio_summary.unpricedCurrencies.join(", ")}
                </p>
              ) : null}
              {(connectionResult.portfolio_assets ?? []).length > 0 ? (
                <div className="mt-3 space-y-1">
                  {(connectionResult.portfolio_assets ?? []).map((asset) => (
                    <p key={asset.currency} className="text-xs font-mono text-foreground/80">
                      {asset.currency}: equity {asset.equity.toFixed(4)} · free {asset.available.toFixed(4)} · locked{" "}
                      {asset.locked.toFixed(4)} · value {asset.usdtValue !== null ? formatUsd(asset.usdtValue) : "n/a"}
                    </p>
                  ))}
                </div>
              ) : (connectionResult.assets ?? []).length > 0 ? (
                <div className="mt-3 space-y-1">
                  {(connectionResult.assets ?? []).map((asset) => (
                    <p key={asset.currency} className="text-xs font-mono text-foreground/80">
                      {asset.currency}: free {Number(asset.availableBalance ?? 0).toFixed(4)} · frozen{" "}
                      {Number(asset.frozenBalance ?? 0).toFixed(4)}
                    </p>
                  ))}
                </div>
              ) : connectionResult.success ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  No non-zero MEXC futures assets were returned for this account.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-card border-border">
        <CardHeader>
          <CardTitle className="text-lg">Trading Configuration</CardTitle>
          <CardDescription>Execution mode, sizing, and automation limits</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label>Paper Mode</Label>
              <p className="text-xs text-muted-foreground">
                Local paper execution with a simulated balance. Live mode requires approved MEXC futures API access.
              </p>
            </div>
            <Switch
              checked={profile.demo_mode}
              onCheckedChange={(value) => setProfile({ ...profile, demo_mode: value })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Auto-Trade</Label>
              <p className="text-xs text-muted-foreground">Allow scheduled rule-based entries and exits</p>
            </div>
            <Switch
              checked={profile.auto_trade}
              onCheckedChange={(value) => setProfile({ ...profile, auto_trade: value })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Trend Setups</Label>
              <p className="text-xs text-muted-foreground">
                Enable pullback and breakout entries when 5m and 15m are aligned.
              </p>
            </div>
            <Switch
              checked={profile.allow_trend_trades}
              onCheckedChange={(value) => setProfile({ ...profile, allow_trend_trades: value })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Mean Reversion Setups</Label>
              <p className="text-xs text-muted-foreground">
                Allow counter-trend reversal entries only in low-ADX range conditions.
              </p>
            </div>
            <Switch
              checked={profile.allow_mean_reversion_trades}
              onCheckedChange={(value) => setProfile({ ...profile, allow_mean_reversion_trades: value })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Max Risk per Trade</Label>
              <span className="text-sm font-mono text-primary">{profile.max_risk_pct.toFixed(1)}%</span>
            </div>
            <Slider
              value={[profile.max_risk_pct]}
              onValueChange={([value]) => setProfile({ ...profile, max_risk_pct: value })}
              min={0.1}
              max={2}
              step={0.1}
              className="py-2"
            />
            <p className="text-[11px] text-muted-foreground">
              Live mode is clamped harder server-side even if you save a larger value.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Leverage</Label>
              <span className="text-sm font-mono text-primary">{profile.leverage}x</span>
            </div>
            <Slider
              value={[profile.leverage]}
              onValueChange={([value]) => setProfile({ ...profile, leverage: value })}
              min={1}
              max={50}
              step={1}
              className="py-2"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Minimum Confidence</Label>
              <span className="text-sm font-mono text-primary">{profile.min_confidence.toFixed(0)}%</span>
            </div>
            <Slider
              value={[profile.min_confidence]}
              onValueChange={([value]) => setProfile({ ...profile, min_confidence: value })}
              min={60}
              max={95}
              step={1}
              className="py-2"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Daily Loss Limit</Label>
              <span className="text-sm font-mono text-primary">{profile.daily_loss_limit_pct.toFixed(1)}%</span>
            </div>
            <Slider
              value={[profile.daily_loss_limit_pct]}
              onValueChange={([value]) => setProfile({ ...profile, daily_loss_limit_pct: value })}
              min={0.5}
              max={10}
              step={0.5}
              className="py-2"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Max Consecutive Losses</Label>
            <Input
              type="number"
              min={1}
              max={8}
              value={profile.max_consecutive_losses}
              onChange={(event) =>
                setProfile({
                  ...profile,
                  max_consecutive_losses: Math.min(8, Math.max(1, Number(event.target.value) || 1)),
                })
              }
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Telegram Chat ID</Label>
            <Input
              value={profile.telegram_id}
              onChange={(event) => setProfile({ ...profile, telegram_id: event.target.value })}
              placeholder="Chat ID for trade and risk alerts"
              className="font-mono text-sm"
            />
          </div>

          <Button onClick={handleSaveProfile} disabled={saving} className="w-full">
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
