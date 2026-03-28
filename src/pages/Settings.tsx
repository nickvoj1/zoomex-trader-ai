import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Eye, EyeOff, CheckCircle, XCircle, Loader2 } from "lucide-react";

export default function SettingsPage() {
  const { user } = useAuth();
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);

  const [keys, setKeys] = useState({
    mexc_key: "",
    mexc_secret: "",
    coincodex_key: "",
    openai_key: "",
    telegram_token: "",
  });

  const [profile, setProfile] = useState({
    auto_trade: false,
    max_risk_pct: 0.5,
    leverage: 10,
    telegram_id: "",
    demo_mode: true,
  });

  useEffect(() => {
    if (!user) return;
    // Load existing settings
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

      const { data: profData } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profData) {
        setProfile({
          auto_trade: profData.auto_trade,
          max_risk_pct: Number(profData.max_risk_pct),
          leverage: profData.leverage,
          telegram_id: profData.telegram_id || "",
        });
      }
    };
    loadSettings();
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
    const { error } = await supabase
      .from("profiles")
      .update({
        auto_trade: profile.auto_trade,
        max_risk_pct: profile.max_risk_pct,
        leverage: profile.leverage,
        telegram_id: profile.telegram_id || null,
      })
      .eq("user_id", user.id);
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Settings saved");
  };

  const maskValue = (val: string) => (showSecrets ? val : val ? "•".repeat(Math.min(val.length, 30)) : "");

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-slide-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage API keys and trading configuration</p>
      </div>

      {/* API Keys */}
      <Card className="glass-card border-border">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">API Keys</CardTitle>
              <CardDescription>Connect to exchanges and services</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowSecrets(!showSecrets)}>
              {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            { key: "mexc_key", label: "MEXC API Key" },
            { key: "mexc_secret", label: "MEXC Secret" },
            { key: "coincodex_key", label: "CoinCodex API Key" },
            { key: "openai_key", label: "OpenAI API Key" },
            { key: "telegram_token", label: "Telegram Bot Token" },
          ].map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label className="text-xs">{field.label}</Label>
              <Input
                type={showSecrets ? "text" : "password"}
                value={keys[field.key as keyof typeof keys]}
                onChange={(e) => setKeys({ ...keys, [field.key]: e.target.value })}
                placeholder={`Enter ${field.label.toLowerCase()}`}
                className="font-mono text-sm"
              />
            </div>
          ))}
          <Button onClick={handleSaveKeys} disabled={saving} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save API Keys
          </Button>
        </CardContent>
      </Card>

      {/* Trading Config */}
      <Card className="glass-card border-border">
        <CardHeader>
          <CardTitle className="text-lg">Trading Configuration</CardTitle>
          <CardDescription>Auto-scalping parameters</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label>Auto-Trade</Label>
              <p className="text-xs text-muted-foreground">Enable automated scalping</p>
            </div>
            <Switch
              checked={profile.auto_trade}
              onCheckedChange={(val) => setProfile({ ...profile, auto_trade: val })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Max Risk per Trade</Label>
              <span className="text-sm font-mono text-primary">{profile.max_risk_pct}%</span>
            </div>
            <Slider
              value={[profile.max_risk_pct]}
              onValueChange={([val]) => setProfile({ ...profile, max_risk_pct: val })}
              min={0.1}
              max={5}
              step={0.1}
              className="py-2"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Leverage</Label>
              <span className="text-sm font-mono text-primary">{profile.leverage}x</span>
            </div>
            <Slider
              value={[profile.leverage]}
              onValueChange={([val]) => setProfile({ ...profile, leverage: val })}
              min={1}
              max={1000}
              step={1}
              className="py-2"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Telegram Chat ID</Label>
            <Input
              value={profile.telegram_id}
              onChange={(e) => setProfile({ ...profile, telegram_id: e.target.value })}
              placeholder="Your Telegram chat ID for alerts"
              className="font-mono text-sm"
            />
          </div>

          <Button onClick={handleSaveProfile} disabled={saving} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save Settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
