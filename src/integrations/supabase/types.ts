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
      execution_events: {
        Row: {
          created_at: string
          details: Json | null
          event_type: string
          id: string
          latency_ms: number | null
          status: string
          symbol: string
          user_id: string | null
          venue: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          event_type: string
          id?: string
          latency_ms?: number | null
          status: string
          symbol?: string
          user_id?: string | null
          venue: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          event_type?: string
          id?: string
          latency_ms?: number | null
          status?: string
          symbol?: string
          user_id?: string | null
          venue?: string
        }
        Relationships: []
      }
      forward_validation_reports: {
        Row: {
          avg_entry_slippage_bps: number
          avg_exit_slippage_bps: number
          avg_holding_minutes: number
          avg_net_edge_usd: number
          created_at: string
          details: Json
          execution_mode: string
          expectancy_usd: number
          gate_passed: boolean
          gate_reason: string | null
          id: string
          max_drawdown_pct: number
          model_assisted_trade_count: number
          profit_factor: number
          symbol: string
          total_fees_usd: number
          total_net_pnl_usd: number
          trade_count: number
          user_id: string | null
          win_rate: number
          window_end: string
          window_start: string
        }
        Insert: {
          avg_entry_slippage_bps?: number
          avg_exit_slippage_bps?: number
          avg_holding_minutes?: number
          avg_net_edge_usd?: number
          created_at?: string
          details?: Json
          execution_mode: string
          expectancy_usd?: number
          gate_passed?: boolean
          gate_reason?: string | null
          id?: string
          max_drawdown_pct?: number
          model_assisted_trade_count?: number
          profit_factor?: number
          symbol?: string
          total_fees_usd?: number
          total_net_pnl_usd?: number
          trade_count?: number
          user_id?: string | null
          win_rate?: number
          window_end: string
          window_start: string
        }
        Update: {
          avg_entry_slippage_bps?: number
          avg_exit_slippage_bps?: number
          avg_holding_minutes?: number
          avg_net_edge_usd?: number
          created_at?: string
          details?: Json
          execution_mode?: string
          expectancy_usd?: number
          gate_passed?: boolean
          gate_reason?: string | null
          id?: string
          max_drawdown_pct?: number
          model_assisted_trade_count?: number
          profit_factor?: number
          symbol?: string
          total_fees_usd?: number
          total_net_pnl_usd?: number
          trade_count?: number
          user_id?: string | null
          win_rate?: number
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      market_snapshots: {
        Row: {
          created_at: string
          cross_venue_basis_bps: number | null
          funding_rate_pct_8h: number | null
          id: string
          imbalance: number | null
          latency_ms: number | null
          liquidation_bias: number | null
          liquidation_intensity: number | null
          long_short_ratio: number | null
          mark_price: number | null
          mid_price: number | null
          open_interest_change_pct: number | null
          open_interest_usd: number | null
          raw_payload: Json | null
          snapshot_type: string
          spread_bps: number | null
          symbol: string
          taker_imbalance: number | null
          venue: string
        }
        Insert: {
          created_at?: string
          cross_venue_basis_bps?: number | null
          funding_rate_pct_8h?: number | null
          id?: string
          imbalance?: number | null
          latency_ms?: number | null
          liquidation_bias?: number | null
          liquidation_intensity?: number | null
          long_short_ratio?: number | null
          mark_price?: number | null
          mid_price?: number | null
          open_interest_change_pct?: number | null
          open_interest_usd?: number | null
          raw_payload?: Json | null
          snapshot_type: string
          spread_bps?: number | null
          symbol?: string
          taker_imbalance?: number | null
          venue: string
        }
        Update: {
          created_at?: string
          cross_venue_basis_bps?: number | null
          funding_rate_pct_8h?: number | null
          id?: string
          imbalance?: number | null
          latency_ms?: number | null
          liquidation_bias?: number | null
          liquidation_intensity?: number | null
          long_short_ratio?: number | null
          mark_price?: number | null
          mid_price?: number | null
          open_interest_change_pct?: number | null
          open_interest_usd?: number | null
          raw_payload?: Json | null
          snapshot_type?: string
          spread_bps?: number | null
          symbol?: string
          taker_imbalance?: number | null
          venue?: string
        }
        Relationships: []
      }
      model_artifacts: {
        Row: {
          artifact: Json
          created_at: string
          horizon_bars: number
          id: string
          metrics: Json
          model_name: string
          move_threshold_pct: number
          side: string
          source_run_id: string | null
          symbol: string
          user_id: string | null
        }
        Insert: {
          artifact?: Json
          created_at?: string
          horizon_bars: number
          id?: string
          metrics?: Json
          model_name: string
          move_threshold_pct: number
          side: string
          source_run_id?: string | null
          symbol?: string
          user_id?: string | null
        }
        Update: {
          artifact?: Json
          created_at?: string
          horizon_bars?: number
          id?: string
          metrics?: Json
          model_name?: string
          move_threshold_pct?: number
          side?: string
          source_run_id?: string | null
          symbol?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "model_artifacts_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "research_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      orderbook_snapshots: {
        Row: {
          asks: Json
          best_ask: number | null
          best_bid: number | null
          bids: Json
          created_at: string
          depth_limit: number
          exchange_timestamp: string | null
          id: string
          imbalance: number | null
          latency_ms: number | null
          raw_payload: Json | null
          spread_bps: number | null
          symbol: string
          venue: string
        }
        Insert: {
          asks?: Json
          best_ask?: number | null
          best_bid?: number | null
          bids?: Json
          created_at?: string
          depth_limit?: number
          exchange_timestamp?: string | null
          id?: string
          imbalance?: number | null
          latency_ms?: number | null
          raw_payload?: Json | null
          spread_bps?: number | null
          symbol?: string
          venue: string
        }
        Update: {
          asks?: Json
          best_ask?: number | null
          best_bid?: number | null
          bids?: Json
          created_at?: string
          depth_limit?: number
          exchange_timestamp?: string | null
          id?: string
          imbalance?: number | null
          latency_ms?: number | null
          raw_payload?: Json | null
          spread_bps?: number | null
          symbol?: string
          venue?: string
        }
        Relationships: []
      }
      position_reconciliations: {
        Row: {
          created_at: string
          exchange_position_count: number
          exchange_snapshot: Json | null
          id: string
          notes: string | null
          open_trade_count: number
          status: string
          symbol: string
          trade_snapshot: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string
          exchange_position_count?: number
          exchange_snapshot?: Json | null
          id?: string
          notes?: string | null
          open_trade_count?: number
          status: string
          symbol?: string
          trade_snapshot?: Json | null
          user_id: string
        }
        Update: {
          created_at?: string
          exchange_position_count?: number
          exchange_snapshot?: Json | null
          id?: string
          notes?: string | null
          open_trade_count?: number
          status?: string
          symbol?: string
          trade_snapshot?: Json | null
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
      research_runs: {
        Row: {
          artifact_path: string | null
          config: Json
          created_at: string
          id: string
          objective: string | null
          run_type: string
          summary: Json
          symbol: string
          user_id: string | null
        }
        Insert: {
          artifact_path?: string | null
          config?: Json
          created_at?: string
          id?: string
          objective?: string | null
          run_type: string
          summary?: Json
          symbol?: string
          user_id?: string | null
        }
        Update: {
          artifact_path?: string | null
          config?: Json
          created_at?: string
          id?: string
          objective?: string | null
          run_type?: string
          summary?: Json
          symbol?: string
          user_id?: string | null
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
      trade_tca: {
        Row: {
          created_at: string
          entry_slippage_bps: number | null
          estimated_fees_usd: number | null
          exit_slippage_bps: number | null
          gross_edge_usd: number | null
          holding_minutes: number | null
          id: string
          metadata: Json | null
          net_edge_usd: number | null
          symbol: string
          trade_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entry_slippage_bps?: number | null
          estimated_fees_usd?: number | null
          exit_slippage_bps?: number | null
          gross_edge_usd?: number | null
          holding_minutes?: number | null
          id?: string
          metadata?: Json | null
          net_edge_usd?: number | null
          symbol?: string
          trade_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          entry_slippage_bps?: number | null
          estimated_fees_usd?: number | null
          exit_slippage_bps?: number | null
          gross_edge_usd?: number | null
          holding_minutes?: number | null
          id?: string
          metadata?: Json | null
          net_edge_usd?: number | null
          symbol?: string
          trade_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_tca_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: true
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_ticks: {
        Row: {
          created_at: string
          exchange_timestamp: string | null
          exchange_trade_id: string | null
          id: string
          notional_usd: number | null
          price: number
          raw_payload: Json | null
          side: string | null
          size: number
          symbol: string
          venue: string
        }
        Insert: {
          created_at?: string
          exchange_timestamp?: string | null
          exchange_trade_id?: string | null
          id?: string
          notional_usd?: number | null
          price: number
          raw_payload?: Json | null
          side?: string | null
          size: number
          symbol?: string
          venue: string
        }
        Update: {
          created_at?: string
          exchange_timestamp?: string | null
          exchange_trade_id?: string | null
          id?: string
          notional_usd?: number | null
          price?: number
          raw_payload?: Json | null
          side?: string | null
          size?: number
          symbol?: string
          venue?: string
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
