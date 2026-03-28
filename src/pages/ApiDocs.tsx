import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const endpoints = [
  {
    method: "POST",
    path: "/functions/v1/test-mexc",
    description: "Validate saved MEXC keys for the authenticated user and return visible balances.",
    params: ["No body required for normal user calls", "user_id: string (service-role only)"],
  },
  {
    method: "POST",
    path: "/functions/v1/scalper",
    description: "Run the rule engine plus optional AI confirmation, then place, close, or hold for the authenticated user.",
    params: [
      "side: long|short|close (optional manual override)",
      "No body for user-triggered analysis-only runs",
      "user_id: string (required only for service-role manual calls)",
    ],
  },
];

export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-slide-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">API Documentation</h1>
        <p className="text-sm text-muted-foreground">
          Authenticated edge functions that are actually implemented in this repository
        </p>
      </div>

      <div className="space-y-4">
        {endpoints.map((endpoint) => (
          <Card key={endpoint.path} className="glass-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <Badge variant={endpoint.method === "GET" ? "outline" : "default"} className="font-mono text-xs">
                  {endpoint.method}
                </Badge>
                <CardTitle className="text-base font-mono">{endpoint.path}</CardTitle>
              </div>
              <CardDescription>{endpoint.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Parameters</p>
                {endpoint.params.map((param) => (
                  <p key={param} className="text-sm font-mono text-foreground/80">
                    • {param}
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
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Browser calls should use the signed-in Supabase session token. Scheduled automation should call
            `scalper` with a service-role token from a secure server or cron job, never from the frontend.
          </p>
          <div className="rounded-lg bg-secondary p-3">
            <code className="text-xs font-mono text-foreground">
              curl -X POST \<br />
              &nbsp;&nbsp;-H "Authorization: Bearer USER_JWT" \<br />
              &nbsp;&nbsp;-H "Content-Type: application/json" \<br />
              &nbsp;&nbsp;-d '{`{"side":"long"}`}' \<br />
              &nbsp;&nbsp;https://your-project.supabase.co/functions/v1/scalper
            </code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
