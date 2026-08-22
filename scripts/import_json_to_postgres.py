"""One-time import of the `.data/*.json` stores into Postgres.

    .venv/Scripts/python.exe scripts/import_json_to_postgres.py --dry-run
    .venv/Scripts/python.exe scripts/import_json_to_postgres.py

SAFE TO RE-RUN. Every insert is `ON CONFLICT (id) DO NOTHING`, so a second run
imports only what is genuinely new. It never updates or deletes an existing row —
if a row is already in Postgres, the database wins. That direction is deliberate:
Postgres is now authoritative, and a re-run of an old JSON file must not be able to
overwrite newer data written since.

THE JSON FILES ARE LEFT IN PLACE. They are the fallback when `DATABASE_URL` is
unset, and they are the only copy of this data until you have verified the import.
Delete them yourself once you are satisfied — this script will not.

WHAT IT DOES NOT DO
-------------------
It cannot read `localStorage`. The browser holds the portfolio, watchlist, chat
history, provider config and exchange-account metadata, and a Python script has no
access to it. Export those from the browser (see SETUP-DATABASE.md) — or simply let
them be recreated, which for a watchlist or a UI preference is usually easier than
migrating.

FOREIGN KEYS ARE REAL AND ARE REPORTED, NOT BYPASSED
----------------------------------------------------
`reflections.trade_id` and `hypotheses.trade_id` reference `trades(id)` with
`ON DELETE CASCADE`. A reflection whose trade is not in the database CANNOT be
inserted. That is correct — a reflection about a trade nothing has a record of is
unanchored — so those rows are skipped and COUNTED, and the summary names how many
and why. Import order below is dependency order so this happens as rarely as
possible.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import asyncpg  # noqa: E402

from backend.core.config import settings  # noqa: E402

DATA = pathlib.Path(__file__).resolve().parents[1] / ".data"


def load(name: str, default):
    """Parse a JSON store, or return `default` when it is missing or unreadable."""
    path = DATA / name
    if not path.exists():
        return default, f"{name}: not present"
    try:
        with path.open(encoding="utf-8") as fh:
            return json.load(fh), None
    except (json.JSONDecodeError, OSError) as exc:
        return default, f"{name}: unreadable ({exc})"


def ms_to_seconds(value):
    """Epoch ms -> epoch seconds for `to_timestamp`, or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value <= 0:
        return None
    return value / 1000.0


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.inserted = 0
        self.skipped = 0

    def store(self, name: str, inserted: int, existing: int, skipped: int, why: str | None = None):
        self.inserted += inserted
        self.skipped += skipped
        detail = f"  {name:22s} +{inserted:<6d} already had {existing:<6d} skipped {skipped}"
        if why:
            detail += f"  ({why})"
        self.lines.append(detail)

    def note(self, text: str):
        self.lines.append(f"  {text}")


async def import_trades(conn, dry: bool, report: Report) -> None:
    """Trades FIRST — reflections, hypotheses, debates and decisions reference them."""
    data, err = load("trades.json", [])
    if err:
        report.store("trades", 0, 0, 0, err)
        return
    rows = [r for r in data if isinstance(r, dict) and r.get("id")]
    existing = await conn.fetchval("SELECT count(*) FROM trades")

    inserted = skipped = 0
    for t in rows:
        ts = ms_to_seconds(t.get("ts"))
        if ts is None:
            skipped += 1
            continue
        # origin_tag has a CHECK constraint; a trade from the browser with no tag
        # is a manual click by definition.
        origin = t.get("originTag") or "manual-click"
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO trades (id, ts, tab, symbol, side, qty, price, note, pnl,
                                entry_context, debate_id, origin_tag, exchange_order_id)
            VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (id) DO NOTHING
            """,
            t["id"], ts, t.get("tab", "paper"), t.get("symbol", "?"), t.get("side", "buy"),
            t.get("qty", 0), t.get("price", 0), t.get("note"), t.get("pnl"),
            t.get("entryContext"), t.get("debateId"), origin, t.get("exchangeOrderId"),
        )
        inserted += 1 if result.endswith("1") else 0
    report.store("trades", inserted, existing, skipped,
                 "skipped = unusable timestamp" if skipped else None)


async def import_missions(conn, dry: bool, report: Report) -> None:
    data, err = load("missions.json", [])
    if err:
        report.store("missions", 0, 0, 0, err)
        return
    rows = [m for m in data if isinstance(m, dict) and m.get("id")]
    existing = await conn.fetchval("SELECT count(*) FROM missions")

    inserted = skipped = 0
    for m in rows:
        created = ms_to_seconds(m.get("createdAt"))
        updated = ms_to_seconds(m.get("updatedAt")) or created
        if created is None:
            skipped += 1
            continue
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO missions (id, type, name, description, status, created_at, updated_at,
                                  expires_at, target, progress, constraints, checkpoints,
                                  baseline_equity_usd)
            VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7),
                    CASE WHEN $8::double precision IS NULL THEN NULL ELSE to_timestamp($8) END,
                    $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13)
            ON CONFLICT (id) DO NOTHING
            """,
            m["id"], m.get("type", "growth"), m.get("name", "Untitled"),
            m.get("description", ""), m.get("status", "paused"), created, updated,
            ms_to_seconds(m.get("expiresAt")),
            json.dumps(m.get("target") or {}), json.dumps(m.get("progress") or {}),
            json.dumps(m.get("constraints") or []), json.dumps(m.get("checkpoints") or []),
            m.get("baselineEquityUsd"),
        )
        inserted += 1 if result.endswith("1") else 0
    report.store("missions", inserted, existing, skipped,
                 "skipped = unusable createdAt" if skipped else None)


async def import_memory_prefs(conn, dry: bool, report: Report) -> None:
    data, err = load("memory-prefs.json", {})
    if err:
        report.store("memory_prefs", 0, 0, 0, err)
        return
    pref = data.get("riskPreference") if isinstance(data, dict) else None
    existing = await conn.fetchval(
        "SELECT count(*) FROM memory_prefs WHERE risk_preference IS NOT NULL"
    )
    if pref not in ("conservative", "moderate", "aggressive"):
        report.store("memory_prefs", 0, existing, 0, "no stated preference to import")
        return
    if not dry:
        await conn.execute(
            """
            INSERT INTO memory_prefs (id, risk_preference, updated_at)
            VALUES ('default', $1, now())
            ON CONFLICT (id) DO UPDATE SET
              -- The one place an UPDATE is right: memory_prefs is a single seeded
              -- row, so DO NOTHING would make the import a silent no-op forever.
              risk_preference = COALESCE(memory_prefs.risk_preference, EXCLUDED.risk_preference),
              updated_at = now()
            """,
            pref,
        )
    report.store("memory_prefs", 1, existing, 0)


async def import_decisions(conn, dry: bool, report: Report) -> None:
    """Decisions. `trade_log_entry_id` references trades, so a dangling link is
    dropped rather than losing the whole audit record."""
    data, err = load("decisions.json", [])
    if err:
        report.store("decisions", 0, 0, 0, err)
        return
    existing = await conn.fetchval("SELECT count(*) FROM decisions")
    trade_ids = {r["id"] for r in await conn.fetch("SELECT id FROM trades")}

    inserted = skipped = unlinked = 0
    for d in data:
        if not isinstance(d, dict) or not d.get("id"):
            skipped += 1
            continue
        ts = ms_to_seconds(d.get("ts"))
        if ts is None:
            skipped += 1
            continue
        link = d.get("tradeLogEntryId")
        if link and link not in trade_ids:
            link = None
            unlinked += 1
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO decisions (id, ts, symbol, side, tab, origin_tag,
                                   requested_qty, requested_price, outcome, urgency,
                                   rejection_reasons, conflict_notes, caution_notes,
                                   risk_checks, stop_loss, take_profit, recommended_qty,
                                   ensemble_consensus, ensemble_confidence_pct,
                                   debate_recommendation, debate_confidence_pct,
                                   rationale, trade_log_entry_id)
            VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9, $10,
                    $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
                    $15, $16, $17, $18, $19, $20, $21, $22, $23)
            ON CONFLICT (id) DO NOTHING
            """,
            d["id"], ts, d.get("symbol", "?"), d.get("side", "buy"), d.get("tab", "paper"),
            d.get("originTag", "manual-click"),
            d.get("requestedQty", 0), d.get("requestedPrice", 0),
            d.get("outcome", "rejected"), d.get("urgency", "normal"),
            json.dumps(d.get("rejectionReasons") or []),
            json.dumps(d.get("conflictNotes") or []),
            json.dumps(d.get("cautionNotes") or []),
            json.dumps(d["riskChecks"]) if d.get("riskChecks") else None,
            d.get("stopLoss"), d.get("takeProfit"), d.get("recommendedQty"),
            d.get("ensembleConsensus"), d.get("ensembleConfidencePct"),
            d.get("debateRecommendation"), d.get("debateConfidencePct"),
            d.get("rationale"), link,
        )
        inserted += 1 if result.endswith("1") else 0
    why = []
    if skipped:
        why.append(f"{skipped} unusable")
    if unlinked:
        why.append(f"{unlinked} trade link dropped (no such trade)")
    report.store("decisions", inserted, existing, skipped, "; ".join(why) or None)


async def import_reflections(conn, dry: bool, report: Report) -> None:
    """Reflections. `trade_id` is a FOREIGN KEY, so one about a trade that is not
    in the database CANNOT be stored — those are skipped and counted, not forced."""
    data, err = load("reflections.json", [])
    if err:
        report.store("reflections", 0, 0, 0, err)
        return
    existing = await conn.fetchval("SELECT count(*) FROM reflections")
    trade_ids = {r["id"] for r in await conn.fetch("SELECT id FROM trades")}

    inserted = orphaned = skipped = 0
    for r in data:
        if not isinstance(r, dict) or not r.get("tradeId"):
            skipped += 1
            continue
        if r["tradeId"] not in trade_ids:
            orphaned += 1
            continue
        ts = ms_to_seconds(r.get("ts"))
        if ts is None:
            skipped += 1
            continue
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO reflections (trade_id, ts, symbol, content, sections,
                                     entry_context_used, exit_context_used, finish_reason)
            VALUES ($1, to_timestamp($2), $3, $4, $5::jsonb, $6, $7, $8)
            ON CONFLICT (trade_id) DO NOTHING
            """,
            r["tradeId"], ts, r.get("symbol", "?"), r.get("content", ""),
            json.dumps(r["sections"]) if r.get("sections") else None,
            r.get("entryContextUsed"), r.get("exitContextUsed", ""), r.get("finishReason"),
        )
        inserted += 1 if result.endswith("1") else 0
    why = []
    if orphaned:
        why.append(f"{orphaned} reference a trade not in the database")
    if skipped:
        why.append(f"{skipped} unusable")
    report.store("reflections", inserted, existing, orphaned + skipped, "; ".join(why) or None)


async def import_hypotheses(conn, dry: bool, report: Report) -> None:
    """Same FK constraint as reflections."""
    data, err = load("hypotheses.json", [])
    if err:
        report.store("hypotheses", 0, 0, 0, err)
        return
    existing = await conn.fetchval("SELECT count(*) FROM hypotheses")
    trade_ids = {r["id"] for r in await conn.fetch("SELECT id FROM trades")}

    inserted = orphaned = skipped = 0
    for h in data:
        if not isinstance(h, dict) or not h.get("id") or not h.get("tradeId"):
            skipped += 1
            continue
        if h["tradeId"] not in trade_ids:
            orphaned += 1
            continue
        ts = ms_to_seconds(h.get("ts"))
        if ts is None:
            skipped += 1
            continue
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO hypotheses (id, trade_id, ts, symbol, claim, suggested_test,
                                    status, review_note, updated_at)
            VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8, to_timestamp($9))
            ON CONFLICT (trade_id) DO NOTHING
            """,
            h["id"], h["tradeId"], ts, h.get("symbol", "?"), h.get("claim", ""),
            h.get("suggestedTest", ""), h.get("status", "proposed"),
            h.get("reviewNote"), ms_to_seconds(h.get("updatedAt")) or ts,
        )
        inserted += 1 if result.endswith("1") else 0
    why = []
    if orphaned:
        why.append(f"{orphaned} reference a trade not in the database")
    if skipped:
        why.append(f"{skipped} unusable")
    report.store("hypotheses", inserted, existing, orphaned + skipped, "; ".join(why) or None)


async def import_debates(conn, dry: bool, report: Report) -> None:
    data, err = load("debate-records.json", [])
    if err:
        report.store("debate_records", 0, 0, 0, err)
        return
    existing = await conn.fetchval("SELECT count(*) FROM debate_records")
    trade_ids = {r["id"] for r in await conn.fetch("SELECT id FROM trades")}

    inserted = skipped = unlinked = 0
    for d in data:
        if not isinstance(d, dict) or not d.get("id"):
            skipped += 1
            continue
        ts = ms_to_seconds(d.get("ts"))
        if ts is None:
            skipped += 1
            continue
        link = d.get("tradeId")
        if link and link not in trade_ids:
            link = None
            unlinked += 1
        # risk_level is CHECK-constrained; anything unexpected would abort the row.
        risk = d.get("riskLevel")
        if risk not in ("Low", "Medium", "High"):
            risk = "Medium"
        outcome = d.get("outcome")
        if outcome not in ("win", "loss"):
            outcome = None
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO debate_records (id, ts, symbol, opinions, moderator, regime,
                                        calibrated_confidence, risk_level,
                                        suggested_position_pct, trade_id, outcome,
                                        outcome_pnl_usd)
            VALUES ($1, to_timestamp($2), $3, $4::jsonb, $5::jsonb, $6::jsonb,
                    $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id) DO NOTHING
            """,
            d["id"], ts, d.get("symbol", "?"),
            json.dumps(d.get("opinions") or []), json.dumps(d.get("moderator") or {}),
            json.dumps(d["regime"]) if d.get("regime") else None,
            d.get("calibratedConfidence"), risk, d.get("suggestedPositionPct"),
            link, outcome, d.get("outcomePnlUsd"),
        )
        inserted += 1 if result.endswith("1") else 0
    why = []
    if unlinked:
        why.append(f"{unlinked} trade link dropped")
    if skipped:
        why.append(f"{skipped} unusable")
    report.store("debate_records", inserted, existing, skipped, "; ".join(why) or None)


async def import_cycles(conn, dry: bool, report: Report) -> None:
    data, err = load("autonomous-cycles.json", [])
    if err:
        report.store("autonomous_cycles", 0, 0, 0, err)
        return
    existing = await conn.fetchval("SELECT count(*) FROM autonomous_cycles")
    mission_ids = {r["id"] for r in await conn.fetch("SELECT id FROM missions")}

    inserted = skipped = unlinked = 0
    for c in data:
        if not isinstance(c, dict) or not c.get("id"):
            skipped += 1
            continue
        ts = ms_to_seconds(c.get("ts"))
        if ts is None:
            skipped += 1
            continue
        outcome = c.get("outcome")
        if outcome not in ("traded", "no-trade", "error"):
            skipped += 1
            continue
        side = c.get("actedSide")
        if side not in ("buy", "sell"):
            side = None
        mission = c.get("missionId")
        if mission and mission not in mission_ids:
            mission = None
            unlinked += 1
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO autonomous_cycles (id, ts, outcome, considered, acted_symbol,
                                           acted_side, acted_margin_usd, acted_leverage,
                                           agent_task_id, decision_summary, mission_id,
                                           mission_progress_pct)
            VALUES ($1, to_timestamp($2), $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id) DO NOTHING
            """,
            c["id"], ts, outcome, json.dumps(c.get("considered") or []),
            c.get("actedSymbol"), side, c.get("actedMarginUsd"), c.get("actedLeverage"),
            c.get("agentTaskId"), c.get("decisionSummary", ""), mission,
            c.get("missionProgressPct"),
        )
        inserted += 1 if result.endswith("1") else 0
    why = []
    if unlinked:
        why.append(f"{unlinked} mission link dropped")
    if skipped:
        why.append(f"{skipped} unusable or unknown outcome")
    report.store("autonomous_cycles", inserted, existing, skipped, "; ".join(why) or None)


async def import_strategy_versions(conn, dry: bool, report: Report) -> None:
    data, err = load("strategy-versions.json", [])
    if err:
        report.store("strategy_versions", 0, 0, 0, err)
        return
    existing = await conn.fetchval("SELECT count(*) FROM strategy_versions")

    inserted = skipped = 0
    for v in data:
        if not isinstance(v, dict) or not v.get("id"):
            skipped += 1
            continue
        ts = ms_to_seconds(v.get("ts"))
        # Three CHECK-constrained columns; an unexpected value aborts the row, so
        # it is reported rather than coerced into something that reads as real.
        if ts is None or v.get("assetType") not in ("crypto", "equity"):
            skipped += 1
            continue
        if v.get("objective") not in (
            "profitFactor", "totalReturnPct", "sharpeApprox", "expectancyUsd"
        ):
            skipped += 1
            continue
        if v.get("algorithm") not in ("grid", "random", "genetic", "bayesian"):
            skipped += 1
            continue
        if dry:
            inserted += 1
            continue
        result = await conn.execute(
            """
            INSERT INTO strategy_versions (id, ts, symbol, asset_type, interval, objective,
                                           algorithm, params, train_metrics, test_metrics,
                                           stability_score, note)
            VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                    $10::jsonb, $11, $12)
            ON CONFLICT (id) DO NOTHING
            """,
            v["id"], ts, v.get("symbol", "?"), v["assetType"], v.get("interval", "1h"),
            v["objective"], v["algorithm"], json.dumps(v.get("params") or {}),
            json.dumps(v["trainMetrics"]) if v.get("trainMetrics") else None,
            json.dumps(v["testMetrics"]) if v.get("testMetrics") else None,
            v.get("stabilityScore"), v.get("note"),
        )
        inserted += 1 if result.endswith("1") else 0
    report.store("strategy_versions", inserted, existing, skipped,
                 f"{skipped} failed a CHECK-constrained field" if skipped else None)


async def import_news_usage(conn, dry: bool, report: Report) -> None:
    """Only imported when the stored date is TODAY. Yesterday's call counts are
    meaningless — the free-tier limits they track have already reset."""
    data, err = load("news-usage.json", {})
    if err:
        report.store("news_provider_usage", 0, 0, 0, err)
        return
    import datetime

    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    counts = data.get("counts") if isinstance(data, dict) else None
    existing = await conn.fetchval("SELECT count(*) FROM news_provider_usage")
    if not counts or data.get("date") != today:
        report.store("news_provider_usage", 0, existing, 0,
                     "stored date is not today — counts have already reset")
        return
    if not dry:
        await conn.execute(
            """
            INSERT INTO news_provider_usage (id, date, counts)
            VALUES ('default', (now() AT TIME ZONE 'utc')::date, $1::jsonb)
            ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, counts = EXCLUDED.counts
            """,
            json.dumps(counts),
        )
    report.store("news_provider_usage", 1, existing, 0)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be imported and write nothing")
    args = parser.parse_args()

    dsn = settings.DATABASE_URL
    if not dsn:
        print("DATABASE_URL is not set. See SETUP-DATABASE.md.")
        return 2

    redacted = dsn
    if "@" in dsn and "://" in dsn:
        head, tail = dsn.split("://", 1)
        creds, host = tail.split("@", 1)
        user = creds.split(":", 1)[0]
        redacted = f"{head}://{user}:***@{host}"

    print(f"Target: {redacted}")
    print(f"Mode  : {'DRY RUN (no writes)' if args.dry_run else 'IMPORT'}\n")

    try:
        conn = await asyncpg.connect(dsn=dsn)
    except Exception as exc:
        print(f"Could not connect: {type(exc).__name__}: {exc}")
        return 1

    report = Report()
    try:
        # DEPENDENCY ORDER MATTERS. trades first, because reflections,
        # hypotheses, debates and decisions all reference a trade id; missions
        # before cycles, which reference a mission id. Getting this wrong turns a
        # satisfiable foreign key into a skipped row.
        await import_trades(conn, args.dry_run, report)
        await import_missions(conn, args.dry_run, report)
        await import_memory_prefs(conn, args.dry_run, report)
        await import_decisions(conn, args.dry_run, report)
        await import_reflections(conn, args.dry_run, report)
        await import_hypotheses(conn, args.dry_run, report)
        await import_debates(conn, args.dry_run, report)
        await import_cycles(conn, args.dry_run, report)
        await import_strategy_versions(conn, args.dry_run, report)
        await import_news_usage(conn, args.dry_run, report)
    finally:
        await conn.close()

    print("Store                  imported  existing        skipped")
    print("-" * 68)
    for line in report.lines:
        print(line)
    print("-" * 68)
    print(f"  {report.inserted} row(s) imported, {report.skipped} skipped")

    print(
        "\nNot covered by this script:\n"
        "  * localStorage (portfolio, watchlist, chat history, provider config,\n"
        "    exchange accounts) — a Python script cannot read a browser. See\n"
        "    SETUP-DATABASE.md.\n"
        "  * graph_checkpoints.sqlite and db/knowledge_graph.db — LangGraph's own\n"
        "    checkpointer and the knowledge graph. Both are managed by their\n"
        "    libraries; leave them alone.\n"
        "\nA 'skipped' count is not a failure to hide: a reflection or hypothesis\n"
        "whose trade is not in the database CANNOT be stored, because it is anchored\n"
        "to that trade by foreign key. The reason is printed next to the count."
    )
    if args.dry_run:
        print("\nDRY RUN — nothing was written. Re-run without --dry-run to import.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
