import { createClient } from "@supabase/supabase-js";

interface QueryResult<T = unknown> {
  data: T;
  error: { message: string } | null;
}

interface InsertSelectBuilder {
  select: (columns: string) => {
    maybeSingle: () => Promise<QueryResult<{ id?: string } | null>>;
  };
}

interface SupabaseWriter {
  from: (table: string) => {
    insert: (values: unknown) => InsertSelectBuilder;
  };
}

export function maybeCreateSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  return createClient(supabaseUrl, serviceRoleKey) as unknown as SupabaseWriter;
}

export async function insertResearchRun(payload: Record<string, unknown>) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.from("research_runs").insert(payload as unknown).select("id").maybeSingle();
  if (error) {
    throw error;
  }
  return data?.id ?? null;
}

export async function insertModelArtifact(payload: Record<string, unknown>) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.from("model_artifacts").insert(payload as unknown).select("id").maybeSingle();
  if (error) {
    throw error;
  }
  return data?.id ?? null;
}
