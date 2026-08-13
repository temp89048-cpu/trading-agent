# 13. Database Schema

This document defines the schema for the 14 core data stores required by the TradingOS platform. All schemas are designed for a **PostgreSQL** backend, utilizing `JSONB` for semi-structured documents and `TIMESTAMPTZ` for rigorous time-series tracking.

---

## 1. Trades Store
**Purpose:** Stores every order, fill, and position lifecycle event.

**Table:** `trades`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | Unique identifier for the trade |
| `tar_id` | `UUID` | NOT NULL | Links back to the approved Trade Authorization Request |
| `symbol` | `VARCHAR` | NOT NULL | e.g., "BTC/USDT" |
| `side` | `VARCHAR` | NOT NULL | 'LONG' or 'SHORT' |
| `status` | `VARCHAR` | NOT NULL | 'OPEN', 'CLOSED', 'LIQUIDATED' |
| `entry_price` | `NUMERIC` | NOT NULL | Average fill price for entry |
| `exit_price` | `NUMERIC` | NULL | Average fill price for exit |
| `qty` | `NUMERIC` | NOT NULL | Position size |
| `leverage` | `INT` | DEFAULT 1 | Leverage used |
| `realized_pnl` | `NUMERIC` | NULL | Final Profit/Loss |
| `created_at` | `TIMESTAMPTZ` | DEFAULT NOW() | When the position was opened |
| `closed_at` | `TIMESTAMPTZ` | NULL | When the position was closed |

- **Indexes:** `idx_trades_symbol`, `idx_trades_status`, `idx_trades_created_at`
- **Retention:** Indefinite (Never delete).

---

## 2. Strategies Store
**Purpose:** Versioned strategy definitions and their operational status.

**Table:** `strategies`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | Unique strategy ID |
| `name` | `VARCHAR` | UNIQUE | E.g., "MeanReversion_v2" |
| `version` | `VARCHAR` | NOT NULL | Semantic versioning |
| `parameters` | `JSONB` | NOT NULL | Configuration (thresholds, windows) |
| `status` | `VARCHAR` | NOT NULL | 'ACTIVE', 'SHADOW', 'RETIRED' |
| `author` | `VARCHAR` | NOT NULL | Agent or Human who created it |
| `created_at` | `TIMESTAMPTZ` | DEFAULT NOW() | - |

- **Indexes:** `idx_strategies_status`, `idx_strategies_name`
- **Retention:** Indefinite.

---

## 3. Memory Store
**Purpose:** Short/long-term agent memory and past mistakes.

**Table:** `agent_memory`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `agent_id` | `VARCHAR` | NOT NULL | Which agent owns this memory |
| `memory_type` | `VARCHAR` | NOT NULL | 'MISTAKE', 'PATTERN', 'STATE' |
| `content` | `JSONB` | NOT NULL | The memory payload |
| `embedding` | `VECTOR(1536)` | NULL | Vector embedding for semantic search |
| `importance` | `INT` | NOT NULL | 1-10 rating of how critical this is |
| `created_at` | `TIMESTAMPTZ` | DEFAULT NOW() | - |
| `expires_at` | `TIMESTAMPTZ` | NULL | TTL for short-term memory |

- **Indexes:** `idx_memory_agent_type`, `idx_memory_expires`
- **Retention:** Ephemeral rows deleted upon `expires_at`. High importance kept indefinitely.

---

## 4. Knowledge Store
**Purpose:** The Knowledge Graph (entities + relationships) regarding macro economics, protocols, and hacks.

**Table:** `knowledge_graph`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `entity` | `VARCHAR` | NOT NULL | E.g., "Federal Reserve", "FTX" |
| `relationship`| `VARCHAR` | NOT NULL | E.g., "IMPACTS", "HACKED" |
| `target` | `VARCHAR` | NOT NULL | E.g., "Interest Rates", "Solana" |
| `confidence` | `NUMERIC` | NOT NULL | 0.0 to 1.0 confidence score |
| `source` | `VARCHAR` | NULL | URL or API where learned |
| `created_at` | `TIMESTAMPTZ` | DEFAULT NOW() | - |

- **Indexes:** `idx_kg_entity`, `idx_kg_target`
- **Retention:** Indefinite.

---

## 5. Research Store
**Purpose:** Hypotheses, findings, validation status from the Research Agent.

**Table:** `research_logs`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `hypothesis` | `TEXT` | NOT NULL | What is being tested |
| `status` | `VARCHAR` | NOT NULL | 'PENDING', 'VALIDATED', 'FALSIFIED' |
| `findings` | `JSONB` | NULL | Backtest results and p-values |
| `dataset_used`| `VARCHAR` | NOT NULL | E.g., "BTC_2020-2023_1h" |
| `created_at` | `TIMESTAMPTZ` | DEFAULT NOW() | - |
| `resolved_at` | `TIMESTAMPTZ` | NULL | - |

- **Indexes:** `idx_research_status`
- **Retention:** Indefinite.

---

## 6. Portfolio Store
**Purpose:** Current and historical allocation, exposure, correlation.

**Table:** `portfolio_snapshots`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `timestamp` | `TIMESTAMPTZ` | NOT NULL | Snapshot time |
| `total_equity`| `NUMERIC` | NOT NULL | Total account value in USD |
| `allocations` | `JSONB` | NOT NULL | Symbol -> % exposure mapping |
| `correlations`| `JSONB` | NOT NULL | Matrix of current portfolio correlation |
| `var_95` | `NUMERIC` | NOT NULL | Value at Risk (95%) |

- **Indexes:** `idx_portfolio_timestamp`
- **Retention:** Rolling 3 years (aggregated to daily after 30 days).

---

## 7. Market Store
**Purpose:** Raw and normalized market data.

**Table:** `market_data_1m` (Hypertable recommended via TimescaleDB)
| Column | Type | Constraints | Description |
|---|---|---|---|
| `timestamp` | `TIMESTAMPTZ` | NOT NULL | Candle open time |
| `symbol` | `VARCHAR` | NOT NULL | E.g., "BTC/USDT" |
| `open` | `NUMERIC` | NOT NULL | - |
| `high` | `NUMERIC` | NOT NULL | - |
| `low` | `NUMERIC` | NOT NULL | - |
| `close` | `NUMERIC` | NOT NULL | - |
| `volume` | `NUMERIC` | NOT NULL | Base asset volume |

- **Indexes:** `(symbol, timestamp)` composite index.
- **Retention:** 1-minute data kept for 6 months. 1-hour data kept indefinitely.

---

## 8. Features Store
**Purpose:** Engineered features used by models (prevents recalculation).

**Table:** `model_features`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `timestamp` | `TIMESTAMPTZ` | NOT NULL | Feature observation time |
| `symbol` | `VARCHAR` | NOT NULL | - |
| `feature_name`| `VARCHAR` | NOT NULL | E.g., "orderbook_imbalance_5m" |
| `feature_val` | `NUMERIC` | NOT NULL | - |

- **Indexes:** `(symbol, feature_name, timestamp)`
- **Retention:** 7 days (rolling buffer for real-time inference).

---

## 9. Indicators Store
**Purpose:** Computed technical/structural indicators (MTF Trends, Support/Resistance).

**Table:** `market_indicators`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `timestamp` | `TIMESTAMPTZ` | NOT NULL | - |
| `symbol` | `VARCHAR` | NOT NULL | - |
| `timeframe` | `VARCHAR` | NOT NULL | "15m", "1h", "4h" |
| `data` | `JSONB` | NOT NULL | Contains RSI, MACD, ATR, Support levels |

- **Indexes:** `(symbol, timeframe, timestamp)`
- **Retention:** 30 days.

---

## 10. News Store
**Purpose:** Ingested news + sentiment scoring.

**Table:** `news_feed`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `timestamp` | `TIMESTAMPTZ` | NOT NULL | Publication time |
| `source` | `VARCHAR` | NOT NULL | E.g., "CoinDesk", "Twitter:TreeNews" |
| `headline` | `TEXT` | NOT NULL | Raw headline |
| `sentiment` | `NUMERIC` | NOT NULL | -1.0 to 1.0 score |
| `entities` | `JSONB` | NOT NULL | Array of tagged symbols/entities |

- **Indexes:** `idx_news_timestamp`, GIN index on `entities`
- **Retention:** 5 years.

---

## 11. Reflection Store
**Purpose:** Post-trade reflections and lessons.

**Table:** `reflections`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `trade_id` | `UUID` | UNIQUE, FK| Links to `trades` table |
| `timestamp` | `TIMESTAMPTZ` | DEFAULT NOW() | - |
| `expected_pnl`| `NUMERIC` | NOT NULL | What the agent thought would happen |
| `actual_pnl` | `NUMERIC` | NOT NULL | What actually happened |
| `lesson` | `TEXT` | NOT NULL | LLM generated lesson |
| `category` | `VARCHAR` | NOT NULL | 'TIMING', 'SIZING', 'MARKET_REGIME' |

- **Indexes:** `idx_reflections_category`
- **Retention:** Indefinite.

---

## 12. Evaluation Store
**Purpose:** Decision-quality scores, benchmark comparisons.

**Table:** `agent_evaluations`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `agent_id` | `VARCHAR` | NOT NULL | E.g., "Supervisor", "Debate" |
| `epoch` | `DATE` | NOT NULL | Evaluation period |
| `score` | `NUMERIC` | NOT NULL | Overall grade (0-100) |
| `benchmark_pnl`|`NUMERIC` | NOT NULL | Buy & Hold PnL over same epoch |
| `agent_pnl` | `NUMERIC` | NOT NULL | Agent's generated PnL |
| `sharpe_ratio`| `NUMERIC` | NOT NULL | - |

- **Indexes:** `idx_eval_agent_epoch`
- **Retention:** Indefinite.

---

## 13. Agent Health Store
**Purpose:** Heartbeats, latency, error rates per agent.

**Table:** `agent_health_metrics`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `timestamp` | `TIMESTAMPTZ` | NOT NULL | - |
| `agent_id` | `VARCHAR` | NOT NULL | - |
| `status` | `VARCHAR` | NOT NULL | 'RUNNING', 'ERROR', 'DEAD' |
| `latency_ms` | `INT` | NOT NULL | - |
| `cpu_usage` | `NUMERIC` | NULL | - |
| `error_msg` | `TEXT` | NULL | Stack trace if status is ERROR |

- **Indexes:** `idx_health_agent_time`
- **Retention:** 7 days (rolling buffer).

---

## 14. Risk Store
**Purpose:** Risk events, limit breaches, CRO decisions.

**Table:** `risk_events`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PRIMARY KEY | - |
| `timestamp` | `TIMESTAMPTZ` | DEFAULT NOW() | - |
| `tar_id` | `UUID` | NULL | Associated TAR (if any) |
| `event_type` | `VARCHAR` | NOT NULL | 'HARD_BREACH', 'SOFT_WARNING', 'LIQUIDATION' |
| `severity` | `INT` | NOT NULL | 1 (Low) to 10 (Critical) |
| `description` | `TEXT` | NOT NULL | E.g., "Max daily drawdown exceeded" |
| `action_taken`| `VARCHAR` | NOT NULL | E.g., "HALT_TRADING", "REJECT_TAR" |

- **Indexes:** `idx_risk_type`, `idx_risk_timestamp`
- **Retention:** Indefinite (Critical for auditing).
