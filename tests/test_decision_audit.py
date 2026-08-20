"""Every value the code writes to a constrained column must be one the schema accepts.

WHY THIS FILE EXISTS
--------------------
`SupervisorAgent._refuse` wrote `outcome="declined"`. `db/schema.sql` constrains
`decisions.outcome` to six values and "declined" is not one of them, so every refusal
violated the check constraint and was never stored.

It failed silently in the worst possible way. `_persist_decision` caught the error,
logged "Failed to persist decision", and carried on — so the system behaved normally
while the decision log filled up with only the trades that HAPPENED. Most decisions
are refusals, so most of the audit trail was being dropped, and the method's own
docstring says exactly why that must not happen:

    "A decision log that only contains the trades that happened cannot answer
     'why didn't it act on that setup?', which is the question an operator asks
     most often."

Found by enabling the autonomy gates and reading the server log, not by the 1288-test
suite — because nothing tested the code against the schema. Unit tests mocked the DB,
and the DB was the thing that disagreed.

WHAT THIS CHECKS
----------------
Cross-references the two artifacts directly: the CHECK constraints in `db/schema.sql`
against the string literals the Python code passes for those columns. That is a class
of bug no amount of mocking can catch, because the mock always accepts.
"""

from __future__ import annotations

import ast
import pathlib
import re

import pytest

SCHEMA = pathlib.Path("db/schema.sql")
BACKEND = pathlib.Path("backend")


def _check_constraint_values(column: str, table_hint: str) -> set[str]:
    """Allowed values for `column`, parsed out of its CHECK (... IN (...)) clause.

    Parsed rather than hardcoded here: a copy of the list in the test would drift from
    the schema, and then the test would be asserting agreement with itself.
    """
    sql = SCHEMA.read_text(encoding="utf-8")

    table_start = sql.index(f"CREATE TABLE {table_hint}")
    table_end = sql.index("CREATE TABLE", table_start + 1) if sql.count(
        "CREATE TABLE", table_start + 1
    ) else len(sql)
    body = sql[table_start:table_end]

    match = re.search(
        rf"{column}\s+text[^,]*?CHECK\s*\(\s*{column}\s+IN\s*\((.*?)\)\s*\)",
        body,
        re.S,
    )
    assert match, f"no CHECK (…IN…) found for {table_hint}.{column}"
    return set(re.findall(r"'([^']+)'", match.group(1)))


def _literals_passed_as(kwarg: str) -> dict[str, set[str]]:
    """Every string literal passed as `kwarg=` anywhere under backend/, by file."""
    found: dict[str, set[str]] = {}
    for path in BACKEND.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            for kw in node.keywords:
                if kw.arg != kwarg:
                    continue
                if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                    found.setdefault(path.as_posix(), set()).add(kw.value.value)
    return found


def test_the_schema_still_constrains_the_decision_outcome():
    """If the constraint is ever dropped, the test below silently passes forever."""
    allowed = _check_constraint_values("outcome", "decisions")
    assert "rejected" in allowed
    assert "approved-executed" in allowed
    assert len(allowed) >= 6


def test_no_code_writes_a_decision_outcome_the_schema_rejects():
    """THE BUG THIS FILE WAS WRITTEN FOR.

    `outcome="declined"` was written by `SupervisorAgent._refuse` and rejected by the
    database on every single refusal.
    """
    allowed = _check_constraint_values("outcome", "decisions")

    # `outcome=` is also used for prediction-market outcome HANDLES, which have
    # nothing to do with this column — those live in the polymarket modules and the
    # research/validation tooling. Restricted to the files that actually write the
    # `decisions` table.
    writers = {
        path: values
        for path, values in _literals_passed_as("outcome").items()
        if "polymarket" in path or "supervisor_agent" in path or "audit" in path
    }
    decision_writers = {
        path: values for path, values in writers.items() if "polymarket" not in path
    }
    assert decision_writers, "no decision writer found — has _persist_decision moved?"

    for path, values in decision_writers.items():
        bad = values - allowed
        assert not bad, (
            f"{path} writes decisions.outcome={sorted(bad)}, which "
            f"db/schema.sql rejects. Allowed: {sorted(allowed)}. Every such row fails "
            f"the check constraint and is silently dropped from the audit trail."
        )


def test_the_refusal_path_writes_a_persistable_outcome():
    """Named separately because refusals are the MAJORITY of decisions, so this is
    where losing rows costs the most."""
    import inspect

    from backend.agents.supervisor_agent import SupervisorAgent

    src = inspect.getsource(SupervisorAgent._refuse)
    tree = ast.parse(src.strip())
    outcomes = {
        kw.value.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        for kw in node.keywords
        if kw.arg == "outcome"
        and isinstance(kw.value, ast.Constant)
        and isinstance(kw.value.value, str)
    }
    allowed = _check_constraint_values("outcome", "decisions")
    assert outcomes, "_refuse no longer passes an outcome literal"
    assert outcomes <= allowed, f"_refuse writes {sorted(outcomes - allowed)}"


@pytest.mark.parametrize("table,column,sample", [
    ("autonomous_cycles", "outcome", "traded"),
    ("decisions", "tab", "paper"),
    ("decisions", "side", "buy"),
])
def test_other_constrained_columns_are_parseable(table, column, sample):
    """Guards the parser itself. If `_check_constraint_values` silently returned an
    empty set, every assertion above would pass vacuously."""
    allowed = _check_constraint_values(column, table)
    assert sample in allowed, (allowed, sample)
