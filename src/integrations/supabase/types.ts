export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          coincodex_key: string | null
          created_at: string
          id: string
          mexc_key: string | null
          mexc_secret: string | null
          openai_key: string | null
          telegram_token: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          coincodex_key?: string | null
          created_at?: string
          id?: string
          mexc_key?: string | null
          mexc_secret?: string | null
          openai_key?: string | null
          telegram_token?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          coincodex_key?: string | null
          created_at?: string
          id?: string
          mexc_key?: string | null
          mexc_secret?: string | null
          openai_key?: string | null
          telegram_token?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          allow_mean_reversion_trades: boolean
          allow_trend_trades: boolean
          auto_trade: boolean
          created_at: string
          daily_loss_limit_pct: number
          demo_mode: boolean
          email: string | null
          id: string
          leverage: number
          max_consecutive_losses: number
          max_risk_pct: number
          min_confidence: number
          telegram_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_mean_reversion_trades?: boolean
          allow_trend_trades?: boolean
          auto_trade?: boolean
          created_at?: string
          daily_loss_limit_pct?: number
          demo_mode?: boolean
          email?: string | null
          id?: string
          leverage?: number
          max_consecutive_losses?: number
          max_risk_pct?: number
          min_confidence?: number
          telegram_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_mean_reversion_trades?: boolean
          allow_trend_trades?: boolean
          auto_trade?: boolean
          created_at?: string
          daily_loss_limit_pct?: number
          demo_mode?: boolean
          email?: string | null
          id?: string
          leverage?: number
          max_consecutive_losses?: number
          max_risk_pct?: number
          min_confidence?: number
          telegram_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          ai_reasoning: string | null
          confidence: number | null
          created_at: string
          decision_source: string | null
          id: string
          price: number | null
          rsi: number | null
          signal: Database["public"]["Enums"]["signal_type"]
          signal_context: Json | null
          symbol: string
          user_id: string
        }
        Insert: {
          ai_reasoning?: string | null
          confidence?: number | null
          created_at?: string
          decision_source?: string | null
          id?: string
          price?: number | null
          rsi?: number | null
          signal?: Database["public"]["Enums"]["signal_type"]
          signal_context?: Json | null
          symbol?: string
          user_id: string
        }
        Update: {
          ai_reasoning?: string | null
          confidence?: number | null
          created_at?: string
          decision_source?: string | null
          id?: string
          price?: number | null
          rsi?: number | null
          signal?: Database["public"]["Enums"]["signal_type"]
          signal_context?: Json | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          closed_at: string | null
          created_at: string
          entry_confidence: number | null
          entry_price: number
          exit_price: number | null
          id: string
          leverage: number
          pnl: number | null
          setup_type: string | null
          side: string
          size: number
          sl: number | null
          status: Database["public"]["Enums"]["trade_status"]
          symbol: string
          tp: number | null
          trade_metadata: Json | null
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          entry_confidence?: number | null
          entry_price: number
          exit_price?: number | null
          id?: string
          leverage?: number
          pnl?: number | null
          setup_type?: string | null
          side: string
          size: number
          sl?: number | null
          status?: Database["public"]["Enums"]["trade_status"]
          symbol?: string
          tp?: number | null
          trade_metadata?: Json | null
          user_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          entry_confidence?: number | null
          entry_price?: number
          exit_price?: number | null
          id?: string
          leverage?: number
          pnl?: number | null
          setup_type?: string | null
          side?: string
          size?: number
          sl?: number | null
          status?: Database["public"]["Enums"]["trade_status"]
          symbol?: string
          tp?: number | null
          trade_metadata?: Json | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      signal_type: "buy" | "sell" | "hold"
      trade_status: "open" | "closed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      signal_type: ["buy", "sell", "hold"],
      trade_status: ["open", "closed"],
    },
  },
} as const
