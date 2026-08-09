-- ============================================================================
-- TradingOS AI — PostgreSQL schema (migration target)
--
-- This schema is NOT wired into the app yet. It is a 1:1 mapping of what
-- already exists in:
--   - .data/*.json file-backed stores (lib/*Store.server.ts)
--   - client-side localStorage state (components/*.tsx, lib/storage.ts)
-- to real tables, so a future migration off file/localStorage storage has
-- an exact target instead of being designed from scratch. See db/README.md
-- for how to run this and what changes in application code when you do.
--
-- Conventions used throughout:
--   - text ids, matching the app's existing id format (lib/storage.ts's
--     uid(), or Date.now().toString(36)+random suffix) — no extension
--     required to adopt this as-is.
--   - CHECK constraints instead of native ENUM types (easier to extend
--     later without an ALTER TYPE dance).
--   - jsonb for fields that are already loosely-structured nested objects
--     in the TypeScript types (risk check breakdowns, agent opinions,
--     plan conditions, etc.) rather than forcing them into more tables.
--   - Singleton tables (memory_prefs, paper_account, config,
--     trading_controls) use a fixed id ('default') since this app assumes
--     one operator today — see the multi-user note at the bottom.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — already server-persisted (.data/*.json today)
-- ============================================================================

-- Source: lib/tradeStore.server.ts / TradeLogEntry (lib/types.ts)
CREATE TABLE trades (
  id              text PRIMARY KEY,
  ts              timestamptz NOT NULL,
  tab             text NOT NULL CHECK (tab IN ('paper', 'real')),
  symbol          text NOT NULL,
  side            text NOT NULL CHECK (side IN ('buy', 'sell')),
  qty             numeric NOT NULL,
  price           numeric NOT NULL,
  note            text,
  pnl             numeric,               -- realized P&L; only set on a closing/reducing row
  entry_context   text,                  -- indicator/structure snapshot captured at entry (buy rows only)
  debate_id       text,                  -- links to debate_records.id when acted on from the Debate System
  origin_tag      text CHECK (origin_tag IN ('debate', 'chat-trade-action', 'agent-plan', 'user-command', 'manual-click')),
  -- Set only when this row was actually filled by a live Binance/Bybit
  -- order. Absent on paper rows and on manual 'real' ledger entries made
  -- without a connected exchange.
  exchange_order_id text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_trades_tab_ts ON trades (tab, ts DESC);
CREATE INDEX idx_trades_symbol ON trades (symbol);
COMMENT ON TABLE trades IS 'Append-heavy trade log. Replaces .data/trades.json.';


-- Source: lib/decisionStore.server.ts / DecisionRecord (lib/types.ts)
CREATE TABLE decisions (
  id                       text PRIMARY KEY,
  ts                       timestamptz NOT NULL,
  symbol                   text NOT NULL,
  side                     text NOT NULL CHECK (side IN ('buy', 'sell')),
  tab                      text NOT NULL CHECK (tab IN ('paper', 'real')),
  origin_tag               text NOT NULL,
  requested_qty            numeric NOT NULL,
  requested_price          numeric NOT NULL,
  outcome                  text NOT NULL CHECK (outcome IN (
                              'approved-executed', 'approved-not-executed', 'rejected',
                              'pending-approval', 'manually-approved', 'manually-rejected'
                            )),
  urgency                  text NOT NULL,
  rejection_reasons        jsonb NOT NULL DEFAULT '[]',
  conflict_notes           jsonb NOT NULL DEFAULT '[]',
  caution_notes            jsonb NOT NULL DEFAULT '[]',
  risk_checks              jsonb,          -- { [checkName]: { ok, status, detail } }
  stop_loss                numeric,
  take_profit               numeric,
  recommended_qty          numeric,
  ensemble_consensus       text,
  ensemble_confidence_pct  numeric,
  debate_recommendation    text,
  debate_confidence_pct    numeric,
  rationale                text,
  trade_log_entry_id       text REFERENCES trades (id) ON DELETE SET NULL
);
CREATE INDEX idx_decisions_symbol_ts ON decisions (symbol, ts DESC);
CREATE INDEX idx_decisions_outcome ON decisions (outcome);
COMMENT ON TABLE decisions IS 'Complete Audit Trail — every Supervisor decision, not just executed trades. Replaces .data/decisions.json.';
-- Every decision is written once and never edited by application code
-- (see components/Supervisor.tsx / TradingControlsPanel.tsx) — enforce
-- that at the DB layer too, same as strategy_versions below.
REVOKE UPDATE, DELETE ON decisions FROM PUBLIC;


-- Source: lib/reflectionStore.server.ts / ReflectionRecord
CREATE TABLE reflections (
  trade_id             text PRIMARY KEY REFERENCES trades (id) ON DELETE CASCADE,
  ts                   timestamptz NOT NULL,
  symbol               text NOT NULL,
  content              text NOT NULL,
  sections             jsonb,           -- parsed {WHY, FAILED_SIGNAL, EARLIER_EXIT, CONFIDENCE, LESSON}; null if the model didn't follow the labeled format
  entry_context_used   text,
  exit_context_used    text NOT NULL,
  finish_reason        text
);
COMMENT ON TABLE reflections IS 'One post-trade reflection per closed trade. Replaces .data/reflections.json.';


-- Source: lib/memoryStore.server.ts — a SINGLETON today, not a list.
CREATE TABLE memory_prefs (
  id               text PRIMARY KEY DEFAULT 'default',
  risk_preference  text CHECK (risk_preference IN ('conservative', 'moderate', 'aggressive')),
  updated_at       timestamptz
);
INSERT INTO memory_prefs (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE memory_prefs IS 'Only the explicitly-stated risk preference — everything else "memory" surfaces (win rate, favorite assets, active hours) is computed live from trades, never duplicated here. Replaces .data/memory-prefs.json.';


-- Source: lib/debateStore.server.ts / DebateRecord (lib/debate/types.ts)
CREATE TABLE debate_records (
  id                       text PRIMARY KEY,
  ts                       timestamptz NOT NULL,
  symbol                   text NOT NULL,
  opinions                 jsonb NOT NULL,  -- array of {agent, label, recommendation, confidence, evidence[]} — one per of the 7 debate agents
  moderator                jsonb NOT NULL,  -- {recommendation, rawConfidence, agreementSummary, supportingEvidence[], opposingViews[], agentBreakdown[]}
  regime                   jsonb,           -- nullable {trend, vol}
  calibrated_confidence    numeric,
  risk_level               text NOT NULL CHECK (risk_level IN ('Low', 'Medium', 'High')),
  suggested_position_pct   numeric,
  trade_id                 text REFERENCES trades (id) ON DELETE SET NULL,
  outcome                  text CHECK (outcome IN ('win', 'loss')),
  outcome_pnl_usd          numeric
);
CREATE INDEX idx_debate_records_symbol_ts ON debate_records (symbol, ts DESC);
CREATE INDEX idx_debate_records_trade_id ON debate_records (trade_id);
COMMENT ON TABLE debate_records IS 'Starts as a prediction (trade_id/outcome null); updated once linked to a trade that has since closed. Replaces .data/debate-records.json.';


-- Source: lib/strategyVersionStore.server.ts / StrategyVersion — APPEND-ONLY.
CREATE TABLE strategy_versions (
  id               text PRIMARY KEY,
  ts               timestamptz NOT NULL,     -- deployment date
  symbol           text NOT NULL,
  asset_type       text NOT NULL CHECK (asset_type IN ('crypto', 'equity')),
  interval         text NOT NULL,
  objective        text NOT NULL CHECK (objective IN ('profitFactor', 'totalReturnPct', 'sharpeApprox', 'expectancyUsd')),
  algorithm        text NOT NULL CHECK (algorithm IN ('grid', 'random', 'genetic', 'bayesian')),
  params           jsonb NOT NULL,           -- {emaFast, emaSlow, rsiThreshold, atrMultiplier, rewardRiskRatio}
  train_metrics    jsonb,                    -- {tradeCount, winRate, profitFactor, maxDrawdownPct, totalReturnPct}
  test_metrics     jsonb,                    -- same shape, OUT-OF-SAMPLE — the number to trust over train_metrics
  stability_score  numeric,                  -- 0-100, nullable
  note             text
);
CREATE INDEX idx_strategy_versions_symbol_ts ON strategy_versions (symbol, ts DESC);
COMMENT ON TABLE strategy_versions IS 'Versions the Backtest Optimizer''s TunableParams (the live 9-agent Strategy Ensemble is hardcoded with no parameters — nothing to version there). Never overwritten. Replaces .data/strategy-versions.json.';
REVOKE UPDATE, DELETE ON strategy_versions FROM PUBLIC;


-- Source: lib/missionStore.server.ts / Mission (lib/missionPlanner.ts)
CREATE TABLE missions (
  id           text PRIMARY KEY,
  type         text NOT NULL CHECK (type IN (
                 'growth', 'capital-preservation', 'event-reduction',
                 'accumulation', 'cash-allocation', 'capital-target'
               )),
  name         text NOT NULL,
  description  text NOT NULL,
  status       text NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'failed', 'expired')),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  expires_at   timestamptz,          -- NULL = no expiry
  -- Discriminated union on `type` — kept as jsonb rather than six nullable
  -- column sets. Note 'capital-target' deliberately carries NO deadline
  -- (see lib/missionPlanner.ts): a hard time limit on a dollar goal pushes
  -- toward unsafe risk-taking.
  target       jsonb NOT NULL,
  progress     jsonb NOT NULL,       -- {currentPct, status, lastEvaluatedAt, detail}
  constraints  jsonb NOT NULL DEFAULT '[]',
  checkpoints  jsonb NOT NULL DEFAULT '[]'   -- capped at ~100 most recent in application code
);
CREATE INDEX idx_missions_status ON missions (status);
COMMENT ON TABLE missions IS 'Strategic missions (Phase 22). At most one row should be status=active at a time — enforced in application code, not by a DB constraint. Replaces .data/missions.json.';


-- Source: lib/hypothesisStore.server.ts / HypothesisRecord
CREATE TABLE hypotheses (
  id              text PRIMARY KEY,
  trade_id        text NOT NULL REFERENCES trades (id) ON DELETE CASCADE,
  ts              timestamptz NOT NULL,
  symbol          text NOT NULL,
  claim           text NOT NULL,
  suggested_test  text NOT NULL,
  status          text NOT NULL CHECK (status IN ('proposed', 'dismissed', 'validated', 'rejected', 'applied')),
  review_note     text,                -- the human's own note when changing status
  updated_at      timestamptz NOT NULL,
  UNIQUE (trade_id)                    -- upserted by trade_id, matching saveHypothesis()
);
CREATE INDEX idx_hypotheses_status ON hypotheses (status);
COMMENT ON TABLE hypotheses IS
  'Stage 2 of the self-learning pipeline. CRITICAL: status=''applied'' only ever records that a HUMAN made a change themselves — no application code sets it, and nothing here may write to trading_controls or strategy config. See lib/hypothesisAgent.ts. Replaces .data/hypotheses.json.';


-- Source: lib/collaborationStore.server.ts / CollaborationRecord — APPEND-ONLY.
CREATE TABLE collaboration_requests (
  id                  text PRIMARY KEY,
  ts                  timestamptz NOT NULL,
  symbol              text NOT NULL,
  side                text NOT NULL CHECK (side IN ('buy', 'sell')),
  own_confidence_pct  numeric NOT NULL,
  trigger_reason      text NOT NULL,     -- what conflicted / why a second opinion was requested
  provider            text NOT NULL,     -- which second-opinion provider was asked
  model               text NOT NULL,
  opinion             jsonb,             -- {recommendation, confidencePct, reasoning}; NULL if the request failed or didn't parse
  error               text,              -- populated instead of `opinion` on failure — never both null silently
  CHECK (opinion IS NOT NULL OR error IS NOT NULL)
);
CREATE INDEX idx_collaboration_symbol_ts ON collaboration_requests (symbol, ts DESC);
COMMENT ON TABLE collaboration_requests IS
  'Every second-opinion request/response, for attribution. Advisory only — a recorded opinion never overrides Risk or the Supervisor. Replaces .data/collaboration.json.';
REVOKE UPDATE, DELETE ON collaboration_requests FROM PUBLIC;


-- Source: lib/autonomousCycleStore.server.ts / AutonomousCycleRecord
CREATE TABLE autonomous_cycles (
  id                    text PRIMARY KEY,
  ts                    timestamptz NOT NULL,
  outcome               text NOT NULL CHECK (outcome IN ('traded', 'no-trade', 'error')),
  -- The full ranked slate this cycle weighed, best-first, each with its
  -- own reasons AND blockers — so a decision is auditable against what it
  -- was chosen OVER, not just what was chosen.
  considered            jsonb NOT NULL DEFAULT '[]',
  acted_symbol          text,
  acted_side            text CHECK (acted_side IN ('buy', 'sell')),
  acted_margin_usd      numeric,
  acted_leverage        numeric,
  -- Deliberately NOT a foreign key to agent_tasks. That table is in
  -- SECTION 2 (client-side localStorage today), so a FK here would both
  -- fail on execution order and break a Section-1-only migration — which
  -- is the realistic first migration, since Section 1 is what's already
  -- server-persisted. Add the constraint if and when agent_tasks actually
  -- moves server-side.
  agent_task_id         text,
  -- Always populated, including for no-trade cycles. A cycle that decided
  -- not to trade is still a decision and must state why.
  decision_summary      text NOT NULL,
  mission_id            text REFERENCES missions (id) ON DELETE SET NULL,
  mission_progress_pct  numeric
);
CREATE INDEX idx_autonomous_cycles_ts ON autonomous_cycles (ts DESC);
CREATE INDEX idx_autonomous_cycles_outcome ON autonomous_cycles (outcome);
COMMENT ON TABLE autonomous_cycles IS
  'Journal of EVERY autonomous loop cycle including no-trade ones. Unlike the other append-only stores this one is TRIMMED (application code keeps the most recent 500) because it appends on a fixed interval indefinitely. Replaces .data/autonomous-cycles.json.';


-- Source: lib/newsProviderUsage.server.ts — a SINGLETON daily counter,
-- reset when the UTC date rolls over. Exists to respect free-tier news
-- provider quotas, not as analytics.
CREATE TABLE news_provider_usage (
  id      text PRIMARY KEY DEFAULT 'default',
  date    date NOT NULL,        -- UTC date these counts belong to
  counts  jsonb NOT NULL DEFAULT '{}'   -- { [providerId]: callCount }
);
COMMENT ON TABLE news_provider_usage IS 'Per-UTC-day news API call counts. Replaces .data/news-usage.json.';


-- ============================================================================
-- SECTION 2 — currently client-side only (localStorage), included for
-- completeness if you ever centralize chat/portfolio/agent state server-side.
-- ============================================================================

-- Source: components/AppState.tsx / Conversation, Message (lib/types.ts)
CREATE TABLE conversations (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE messages (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL,
  ts               timestamptz NOT NULL
);
CREATE INDEX idx_messages_conversation_ts ON messages (conversation_id, ts);


-- Source: components/Portfolio.tsx / PortfolioState, Position (lib/types.ts)
CREATE TABLE positions (
  id        bigserial PRIMARY KEY,
  tab       text NOT NULL CHECK (tab IN ('paper', 'real')),
  symbol    text NOT NULL,
  qty       numeric NOT NULL,
  avg_cost  numeric NOT NULL,
  UNIQUE (tab, symbol)
);

CREATE TABLE paper_account (
  id    text PRIMARY KEY DEFAULT 'default',
  cash  numeric NOT NULL
);
INSERT INTO paper_account (id, cash) VALUES ('default', 25000) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE paper_account IS 'Real tab has no tracked cash/equity in this app by design — see lib/riskManager.ts''s checkPositionRisk. Starting balance (25000) matches PAPER_STARTING_EQUITY.';


-- Source: lib/types.ts / AgentTask — includes the advanced-agent fields
-- (trailing stop, scale-out, ATR stops, signal-gated entries).
CREATE TABLE agent_tasks (
  id                            text PRIMARY KEY,
  conversation_id               text REFERENCES conversations (id) ON DELETE SET NULL,
  tab                           text NOT NULL CHECK (tab IN ('paper', 'real')),
  symbol                        text NOT NULL,
  side                          text NOT NULL CHECK (side IN ('buy', 'sell')),
  margin_usd                    numeric NOT NULL,
  leverage                      numeric NOT NULL,
  total_trades                  integer NOT NULL,
  executed_trades               integer NOT NULL DEFAULT 0,
  mode                          text NOT NULL CHECK (mode IN ('interval', 'take-profit', 'conditional-watch')),
  interval_minutes              numeric,
  tp_percent                    numeric,
  sl_percent                    numeric,
  trigger_condition             jsonb,          -- PlanCondition
  watch_condition               jsonb,          -- PlanCondition
  plan_stage                    text CHECK (plan_stage IN ('trigger', 'watch')),
  status                        text NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'error')),
  created_at                    timestamptz NOT NULL,
  next_run_at                   timestamptz,
  current_entry_price           numeric,
  current_qty                   numeric,
  realized_total                numeric NOT NULL DEFAULT 0,
  rationale                     text,
  error_message                 text,
  trailing_stop_percent         numeric,
  current_peak_price            numeric,
  scale_out_levels              jsonb,          -- [{tpPercent, closeFraction}, ...]
  scaled_out_levels             jsonb,          -- [0, 1, ...] indices already fired
  break_even_armed              boolean NOT NULL DEFAULT false,
  use_atr_stops                 boolean NOT NULL DEFAULT false,
  atr_multiplier_tp             numeric,
  atr_multiplier_sl             numeric,
  require_signal_confirmation   boolean NOT NULL DEFAULT false,
  min_ensemble_confidence_pct   numeric,
  min_debate_confidence_pct     numeric,
  -- Continuous monitoring: close an open leg early when the Strategy
  -- Ensemble flips decisively against it. Unset reproduces the original
  -- TP/SL-only behavior. See lib/agentEngine.ts's ThesisContext.
  exit_on_thesis_invalidation   boolean NOT NULL DEFAULT false,
  thesis_exit_confidence_pct    numeric   -- defaults to 70 in code when unset
);
CREATE INDEX idx_agent_tasks_status ON agent_tasks (status);

CREATE TABLE agent_events (
  id               text PRIMARY KEY,
  ts               timestamptz NOT NULL,
  agent_id         text NOT NULL REFERENCES agent_tasks (id) ON DELETE CASCADE,
  conversation_id  text REFERENCES conversations (id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('opened', 'closed', 'completed', 'cancelled', 'error', 'staged')),
  message          text NOT NULL
);
CREATE INDEX idx_agent_events_agent_ts ON agent_events (agent_id, ts);


-- Source: lib/types.ts / WatchItem, Config, McpServer
CREATE TABLE watchlist (
  symbol          text PRIMARY KEY,
  type            text NOT NULL CHECK (type IN ('crypto', 'equity')),
  binance_symbol  text
);

CREATE TABLE config (
  id                 text PRIMARY KEY DEFAULT 'default',
  provider           text NOT NULL,
  model              text NOT NULL DEFAULT '',
  temperature        numeric NOT NULL,
  max_tokens         integer NOT NULL,
  theme              text NOT NULL CHECK (theme IN ('amber', 'cyan', 'green', 'magenta')),
  api_keys           jsonb NOT NULL DEFAULT '{}',   -- see db/README.md's security note before storing this server-side
  base_url_override  text NOT NULL DEFAULT ''
);

CREATE TABLE mcp_servers (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  url   text NOT NULL
);


-- Source: components/TradingControls.tsx — pause/approval-threshold/risk overrides + the pending-approval queue.
CREATE TABLE trading_controls (
  id                             text PRIMARY KEY DEFAULT 'default',
  paused                         boolean NOT NULL DEFAULT false,
  manual_approval_threshold_usd  numeric,
  risk_config_overrides          jsonb NOT NULL DEFAULT '{}',  -- Partial<RiskConfig> — see lib/riskManager.ts's DEFAULT_RISK_CONFIG for the full field list
  -- Operator-declared starting capital for the 'real' tab, which has no
  -- exchange-tracked cash balance. NULL means the equity-dependent risk
  -- checks (position risk, daily loss, drawdown, portfolio exposure) read
  -- 'unavailable' for real trades — see lib/riskManager.ts.
  --
  -- NOTE: this is NOT a hard leverage ceiling. ABSOLUTE_MAX_LEVERAGE lives
  -- in code, deliberately outside RiskConfig, precisely so it cannot be
  -- overridden from configuration — including from this table. Do not add
  -- a leverage column here.
  real_starting_capital_usd      numeric,
  -- Collaboration Protocol second-opinion model. Lives here rather than
  -- in `config` because components/Supervisor.tsx (the consumer) sits
  -- above AppStateProvider in the provider tree and cannot read Config.
  second_opinion_provider           text NOT NULL DEFAULT '',   -- '' = feature disabled
  second_opinion_model              text NOT NULL DEFAULT '',
  second_opinion_api_keys           jsonb NOT NULL DEFAULT '{}',  -- keyed by provider id; see db/README.md's security note
  second_opinion_base_url_override  text NOT NULL DEFAULT ''
);
INSERT INTO trading_controls (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE pending_approvals (
  id                   text PRIMARY KEY,
  dedupe_key           text,             -- e.g. an agent_tasks.id, so a repeating tick loop doesn't queue duplicates
  created_at           timestamptz NOT NULL,
  symbol               text NOT NULL,
  side                 text NOT NULL CHECK (side IN ('buy', 'sell')),
  tab                  text NOT NULL CHECK (tab IN ('paper', 'real')),
  qty                  numeric NOT NULL,
  price                numeric NOT NULL,
  notional_usd         numeric NOT NULL,
  origin_tag           text NOT NULL,
  rationale            text,
  requested_leverage   numeric,
  entry_context        text,
  debate_id            text,
  decision_summary     text NOT NULL
);
CREATE INDEX idx_pending_approvals_dedupe ON pending_approvals (dedupe_key);
