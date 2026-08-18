"""External AI Consultation — spec Section 31 (Phase 48).

    Supervisor -> (uncertainty high) -> Consultation Router
               -> Model A / Model B / Model C / Specialised Model
               -> Evidence Aggregator -> Supervisor

    "**Important: the external AI response is advisory evidence, not authority.**"

HOW THAT SENTENCE IS ENFORCED RATHER THAN STATED
------------------------------------------------
1. `ConsultationResult` has no field any gate reads. It carries opinions and a
   rationale, and nothing else. There is no `approved`, no `size`, no `stop_loss`,
   no `confidence` that position sizing consumes — so an external model cannot
   change what happens even if every response agreed.

2. It is imported by NOTHING in `graphs/`. `consultation` is not a `TradingState`
   field, so a node cannot write one and the Supervisor cannot read one. Wiring it in
   later means adding a state field deliberately, in a diff someone reviews.

3. It never resolves disagreement into a verdict. `aggregate()` reports the SPREAD
   of opinions. A majority vote across models would be exactly the authority the spec
   forbids, dressed as arithmetic — and it would be worse than one model's answer,
   because three models trained on overlapping data agreeing is not three
   independent confirmations.

WHY IT DOES NOT CONSULT ON EVERY DECISION
-----------------------------------------
`should_consult` gates on genuine uncertainty. Section 39.6 warns that a multi-model
graph "can consume tens of thousands of tokens per single decision cycle"; consulting
three models on every trigger would do that while adding nothing on the runs where
the internal evidence is already one-sided.

WHY THE DEFAULT IS TO REFUSE HONESTLY
-------------------------------------
With one provider configured, "three models" is one model asked three times, which is
not a panel — it is the same prior sampled repeatedly, and reporting it as
multi-model consensus would manufacture agreement. So `consult` requires DISTINCT
providers and says plainly when it has fewer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from backend.llm.provider import DEFAULT_TEMPERATURE, LLMProvider, ModelTier

logger = logging.getLogger(__name__)

# Consult only when internal confidence sits in this band.
#
# Below the floor the evidence is already clearly against acting and an outside
# opinion cannot make a bad setup good. Above the ceiling it is clearly for, and
# paying three model calls to confirm something is spending tokens on reassurance.
# The band in between is where an outside view might actually change the reading.
CONSULT_CONFIDENCE_FLOOR = 0.10
CONSULT_CONFIDENCE_CEILING = 0.45

# A panel needs at least this many DISTINCT providers to be called one.
MIN_DISTINCT_PROVIDERS = 2

MAX_TOKENS_PER_OPINION = 400


@dataclass
class Opinion:
    """One external model's response. Carries no authority."""

    provider: str
    # 'agree' | 'disagree' | 'unclear' | None when the call failed.
    stance: Optional[str] = None
    rationale: Optional[str] = None
    tokens_used: int = 0
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None and self.stance is not None


@dataclass
class ConsultationResult:
    """Advisory evidence. Deliberately contains nothing a gate can read.

    No `approved`, no `size`, no `leverage`, no `stop_loss`, and no aggregate
    confidence that sizing could consume. If a future change adds one, it should be
    obvious in review that the field is what turns advice into authority.
    """

    consulted: bool = False
    opinions: List[Opinion] = field(default_factory=list)
    # Why it did not run, or which parts of it could not.
    unavailable: List[str] = field(default_factory=list)
    total_tokens: int = 0

    @property
    def responded(self) -> List[Opinion]:
        return [o for o in self.opinions if o.ok]

    def aggregate(self) -> Dict[str, Any]:
        """Report the SPREAD of opinion. Never a verdict.

        No majority, no weighted score, no single recommendation. Three models
        agreeing is not three independent confirmations — they share training data,
        so their agreement is correlated in a way the reader must be able to see
        rather than have collapsed into a number.
        """
        responded = self.responded
        counts = {
            stance: sum(1 for o in responded if o.stance == stance)
            for stance in ("agree", "disagree", "unclear")
        }
        return {
            "consulted": self.consulted,
            "providersAsked": len(self.opinions),
            "providersResponded": len(responded),
            "stances": counts,
            "opinions": [
                {
                    "provider": o.provider,
                    "stance": o.stance,
                    "rationale": o.rationale,
                    "error": o.error,
                }
                for o in self.opinions
            ],
            "unavailable": self.unavailable,
            "totalTokens": self.total_tokens,
            "authorityMeaning": (
                "ADVISORY EVIDENCE ONLY. Spec Section 31: \"the external AI response "
                "is advisory evidence, not authority.\" No field in this result is "
                "read by the Risk Gateway, the Supervisor's action branches or "
                "position sizing, and nothing here can approve, size or veto a trade. "
                "Unanimous agreement changes nothing"
            ),
            "consensusMeaning": (
                "no majority is computed on purpose. Models trained on overlapping "
                "data agreeing is not independent confirmation, and reducing the "
                "spread to one number would hide that"
            ),
        }


def should_consult(
    internal_confidence: Optional[float],
    directions_disagree: bool = False,
) -> tuple:
    """Is this decision uncertain enough to be worth an outside view?

    Returns `(consult, reason)`. The reason is always populated, including on a no,
    so an operator asking "why wasn't a second opinion taken?" gets an answer.
    """
    if internal_confidence is None:
        # Nothing was measured. An outside model cannot fill in for absent evidence
        # — it would be reasoning over the same gap with more words.
        return False, (
            "internal confidence is unmeasured, so there is no uncertainty to resolve "
            "— an external opinion cannot substitute for missing evidence"
        )

    if directions_disagree:
        return True, (
            f"internal components disagree on direction at {internal_confidence:.2f} "
            f"confidence — the case an outside view is most likely to inform"
        )

    if internal_confidence < CONSULT_CONFIDENCE_FLOOR:
        return False, (
            f"confidence {internal_confidence:.2f} is below the "
            f"{CONSULT_CONFIDENCE_FLOOR} floor: the evidence is already clearly "
            f"against acting, and an outside opinion cannot make a weak setup strong"
        )

    if internal_confidence > CONSULT_CONFIDENCE_CEILING:
        return False, (
            f"confidence {internal_confidence:.2f} is above the "
            f"{CONSULT_CONFIDENCE_CEILING} ceiling: consulting would spend tokens "
            f"confirming a reading that is already one-sided"
        )

    return True, (
        f"confidence {internal_confidence:.2f} is in the "
        f"[{CONSULT_CONFIDENCE_FLOOR}, {CONSULT_CONFIDENCE_CEILING}] uncertainty band"
    )


async def consult(
    question: str,
    internal_view: str,
    providers: Optional[Sequence[LLMProvider]] = None,
) -> ConsultationResult:
    """Ask each DISTINCT provider for a view. Never raises.

    Providers are injected. There is no default panel and no fallback to the single
    configured provider asked three times: that would be one prior sampled
    repeatedly, and presenting it as a panel would manufacture agreement out of
    nothing.
    """
    result = ConsultationResult()

    panel = list(providers or [])
    if not panel:
        result.unavailable.append(
            "no external providers supplied. Section 31's router needs distinct "
            "models; there is no default panel because asking one provider three "
            "times is one opinion, not three"
        )
        return result

    distinct = {p.name for p in panel}
    if len(distinct) < MIN_DISTINCT_PROVIDERS:
        result.unavailable.append(
            f"only {len(distinct)} distinct provider(s) supplied "
            f"({', '.join(sorted(distinct))}); {MIN_DISTINCT_PROVIDERS} are needed for "
            f"this to be a panel rather than one prior sampled repeatedly. Proceeding "
            f"and reporting it as a SINGLE outside opinion"
        )

    system = (
        "You are being asked for a second opinion on a trading view that has ALREADY "
        "been formed by another system. You are advisory: your answer does not "
        "execute, size, or veto anything.\n"
        "Rules:\n"
        "- Answer on the FIRST line with exactly one of: AGREE, DISAGREE, UNCLEAR.\n"
        "- Then two or three sentences of reasoning.\n"
        "- Use only the evidence supplied. Do not introduce prices, indicators or "
        "levels that are not in the input.\n"
        "- UNCLEAR is a valid and often correct answer. Do not manufacture a view to "
        "seem useful."
    )
    user = f"Question: {question}\n\nThe view already formed:\n{internal_view}"

    for provider in panel:
        if not provider.available:
            result.opinions.append(Opinion(
                provider=provider.name,
                error=f"provider '{provider.name}' reports unavailable",
            ))
            continue

        try:
            response = await provider.complete(
                system=system,
                user=user,
                tier=ModelTier.REASONING,
                max_tokens=MAX_TOKENS_PER_OPINION,
                temperature=DEFAULT_TEMPERATURE,
            )
        except Exception as exc:  # noqa: BLE001
            # One provider failing must not lose the others' answers.
            result.opinions.append(Opinion(provider=provider.name, error=str(exc)))
            continue

        # Counted whether or not it succeeded: a failed call still spent a request,
        # and not counting it would understate the cost of consulting.
        result.total_tokens += response.total_tokens

        if not response.ok:
            result.opinions.append(Opinion(
                provider=provider.name,
                error=response.error or "no text returned",
                tokens_used=response.total_tokens,
            ))
            continue

        stance, rationale = _parse(response.text)
        result.opinions.append(Opinion(
            provider=provider.name,
            stance=stance,
            rationale=rationale,
            tokens_used=response.total_tokens,
        ))

    result.consulted = bool(result.responded)
    if not result.consulted:
        result.unavailable.append(
            "no provider returned a usable opinion, so there is no external evidence "
            "— which is not the same as external agreement"
        )

    logger.info(
        "Consultation: %d/%d provider(s) responded, %d tokens. Advisory only.",
        len(result.responded), len(result.opinions), result.total_tokens,
    )
    return result


def _parse(text: str) -> tuple:
    """First line is the stance; the rest is the rationale.

    An unrecognised first line becomes 'unclear' rather than being guessed at. A
    model that did not follow the format has not expressed agreement, and inferring
    one from prose would be reading a stance into text that does not state one.
    """
    lines = [line.strip() for line in (text or "").strip().splitlines() if line.strip()]
    if not lines:
        return None, None

    head = lines[0].upper().rstrip(".:,")
    stance = (
        "agree" if head.startswith("AGREE")
        else "disagree" if head.startswith("DISAGREE")
        else "unclear" if head.startswith("UNCLEAR")
        else None
    )
    rationale = " ".join(lines[1:]).strip() or None

    if stance is None:
        return "unclear", (
            f"the model did not begin with AGREE/DISAGREE/UNCLEAR, so no stance can "
            f"be read from its answer. Full response: {' '.join(lines)[:400]}"
        )
    return stance, rationale
