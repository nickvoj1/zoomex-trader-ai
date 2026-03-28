import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const endpoints = [
  {
    method: "POST",
    path: "/functions/v1/scalper",
    description: "Trigger the auto-scalper. Checks RSI, places orders if conditions met.",
    params: ["symbol (default: BTCUSDT)", "force_check: boolean"],
  },
  {
    method: "POST",
    path: "/functions/v1/place-order",
    description: "Place a market order on Zoomex.",
    params: ["side: buy|sell", "size: number", "leverage: number", "tp: number", "sl: number"],
  },
  {
    method: "GET",
    path: "/functions/v1/signals",
    description: "Get latest signals with AI analysis.",
    params: ["limit: number (default: 20)"],
  },
  {
    method: "POST",
    path: "/functions/v1/analyze",
    description: "Request AI analysis of current market conditions.",
    params: ["rsi: number", "price: number", "symbol: string"],
  },
];

export default function ApiDocsPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-slide-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">API Documentation</h1>
        <p className="text-sm text-muted-foreground">
          Backend function endpoints for webhook testing
        </p>
      </div>

      <div className="space-y-4">
        {endpoints.map((ep) => (
          <Card key={ep.path} className="glass-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <Badge
                  variant={ep.method === "GET" ? "outline" : "default"}
                  className="font-mono text-xs"
                >
                  {ep.method}
                </Badge>
                <CardTitle className="text-base font-mono">{ep.path}</CardTitle>
              </div>
              <CardDescription>{ep.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Parameters
                </p>
                {ep.params.map((p) => (
                  <p key={p} className="text-sm font-mono text-foreground/80">
                    • {p}
                  </p>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="glass-card border-border">
        <CardHeader>
          <CardTitle className="text-lg">Authentication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            All endpoints require a valid Bearer token in the Authorization header.
          </p>
          <div className="bg-secondary rounded-lg p-3">
            <code className="text-xs font-mono text-foreground">
              curl -X POST \<br />
              &nbsp;&nbsp;-H "Authorization: Bearer YOUR_TOKEN" \<br />
              &nbsp;&nbsp;-H "Content-Type: application/json" \<br />
              &nbsp;&nbsp;-d '{`{"side":"buy","size":0.001}`}' \<br />
              &nbsp;&nbsp;https://your-project.supabase.co/functions/v1/place-order
            </code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
