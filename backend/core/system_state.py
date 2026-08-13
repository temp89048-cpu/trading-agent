"""Human-in-the-loop kill switch — the single source of truth.

Spec Section 22.8 ("Infrastructure"): *"Assume the worst case is not 'the
bot makes a bad trade' but 'the bot goes silent while holding a leveraged
position' — design against that specifically."* The operator's pause and
emergency-stop controls are the last line of that defence, so they get a
dedicated module in `core/` rather than living inside an API router.

WHY THIS IS IN `core/` AND NOT IN AN API MODULE
-----------------------------------------------
`api/dashboard.py` had its own private `_SYSTEM_STATE` dict, and
`api/admin.py` (imported by `agents/trading_agent.py`) was about to get a
second one. Two dicts means `POST /api/admin/pause` would set one flag
while every reader of the dashboard's flag carried on trading. A kill
switch that only sometimes works is worse than none, because the operator
believes they have stopped the system. One module, one dict, all readers.

THE OPEN/CLOSE ASYMMETRY IS DELIBERATE
--------------------------------------
`may_open_new_position()` and `may_close_position()` are separate
functions, and the second one always returns True. This is CLAUDE.md
safety invariant 4: closes/exits are never blocked — not by pause, not by
risk checks, not by a debate veto. Refusing to let someone out of a
position they are already in is actively harmful, and more so with real
money, not less. A pause means "stop taking on new risk", never "trap the
operator in current risk".

The two functions exist instead of one `is_system_paused()` so that a
future caller has to state which side it is gating. A single boolean
invites `if paused: return` at the top of a function that also handles
exits, which would silently break the invariant.
`is_system_paused()` is still exported for the existing call site in
`agents/trading_agent.py` and for status display.
"""

import logging
from typing import Dict

logger = logging.getLogger(__name__)

# Not persisted deliberately. A pause is an in-session operator decision,
# and a process restart is itself an intervention — resuming into "paused"
# after a crash would hide the fact that the system came back up. Restart
# recovery is the watchdog's job (see `workers/monitor_worker.py`), not the
# kill switch's.
_SYSTEM_STATE: Dict[str, bool] = {
    "is_paused": False,
    "emergency_stop": False,
    # Observation Mode (spec Section 18): "If portfolio equity drops 10% from
    # the monthly high-water mark, the CRO automatically transitions the system
    # to Observation Mode (close all trades, halt new entries)."
    #
    # Distinct from `is_paused` on purpose. A pause is an operator decision and
    # an operator clears it. Observation Mode is entered automatically by the
    # CEO agent on a drawdown breach, and conflating the two would let a
    # routine operator "resume" silently clear a risk-driven halt while the
    # drawdown that triggered it is still in force.
    "observation_mode": False,
}

# Reason the system entered observation mode, for display and audit. Not a
# bool, because "we halted" without "why" is not actionable.
_OBSERVATION_REASON: Dict[str, str] = {"reason": ""}


def pause(reason: str = "operator request") -> None:
    """Halt NEW position entries. Open positions keep being monitored."""
    _SYSTEM_STATE["is_paused"] = True
    logger.warning("SYSTEM PAUSED (%s) — new entries halted, exits still allowed.", reason)


def resume(reason: str = "operator request") -> None:
    """Clear both pause and emergency stop."""
    _SYSTEM_STATE["is_paused"] = False
    _SYSTEM_STATE["emergency_stop"] = False
    logger.warning("SYSTEM RESUMED (%s).", reason)


def trigger_emergency_stop(reason: str = "operator request") -> None:
    """Hard stop: halt new entries and mark the system as emergency-stopped.

    Sets `is_paused` too, so a caller that only checks the pause flag is
    still stopped. Clearing this requires an explicit `resume()` — it does
    not time out on its own, because an emergency stop that quietly expires
    is indistinguishable from one that was never honoured.
    """
    _SYSTEM_STATE["emergency_stop"] = True
    _SYSTEM_STATE["is_paused"] = True
    logger.critical("EMERGENCY STOP (%s) — all new entries halted.", reason)


def is_system_paused() -> bool:
    """True when new entries are halted. Kept for existing call sites."""
    return _SYSTEM_STATE["is_paused"]


def is_emergency_stopped() -> bool:
    return _SYSTEM_STATE["emergency_stop"]


def enter_observation_mode(reason: str) -> None:
    """Halt new entries because a risk limit was breached, not by operator choice.

    Does NOT set `is_paused`, so `resume()` cannot clear it by accident — see
    the note on `_SYSTEM_STATE["observation_mode"]`. Clearing it requires
    `exit_observation_mode()`, which is a deliberate acknowledgement that the
    breach has been addressed.
    """
    if _SYSTEM_STATE["observation_mode"]:
        return  # already halted; don't spam the log on every subsequent trade
    _SYSTEM_STATE["observation_mode"] = True
    _OBSERVATION_REASON["reason"] = reason
    logger.critical("OBSERVATION MODE ENTERED: %s — new entries halted, exits still allowed.", reason)


def exit_observation_mode(reason: str = "operator acknowledgement") -> None:
    """Leave observation mode. Deliberately separate from resume()."""
    if not _SYSTEM_STATE["observation_mode"]:
        return
    _SYSTEM_STATE["observation_mode"] = False
    _OBSERVATION_REASON["reason"] = ""
    logger.warning("Observation mode cleared (%s).", reason)


def is_in_observation_mode() -> bool:
    return _SYSTEM_STATE["observation_mode"]


def observation_reason() -> str:
    return _OBSERVATION_REASON["reason"]


def may_open_new_position() -> bool:
    """Gate for opening/increasing risk.

    False while paused, emergency-stopped, OR in observation mode. Every
    caller already uses this one function, so adding observation mode here
    applies it everywhere at once rather than needing each gate updated.
    """
    return (
        not _SYSTEM_STATE["is_paused"]
        and not _SYSTEM_STATE["emergency_stop"]
        and not _SYSTEM_STATE["observation_mode"]
    )


def may_close_position() -> bool:
    """Always True — see the open/close asymmetry note in the module docstring.

    Exists so that code gating exits has something honest to call, rather
    than reusing `may_open_new_position()` and accidentally trapping the
    operator in a position during a pause.
    """
    return True


def snapshot() -> Dict[str, bool]:
    """Read-only copy for status endpoints (a copy, so callers can't mutate)."""
    return dict(_SYSTEM_STATE)
