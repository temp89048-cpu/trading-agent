"""Spec Section 9 / Section 22 — every prompt accounted for.

Section 9: *"Every one of these needs its own versioned prompt file."*

Before this, almost every agent's Section 5 `prompt_reference` was the bare
string `"N/A"`. That is unfalsifiable — it reads identically whether the agent
genuinely needs no prompt or whether nobody wrote one. The registry makes the
reference a key that either resolves or does not, and these tests assert every
one resolves and every deterministic entry states WHY it has no prompt.
"""

import pytest

from backend.prompts.registry import (
    DOMAIN_PROMPTS,
    PromptKind,
    all_prompts,
    coverage,
    get_prompt,
    prompt_keys,
)
from tests.test_agent_contracts import _all_agents


# ---------------------------------------------------------------------------
# Every agent's prompt_reference resolves
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_agent_prompt_reference_resolves_to_a_registry_entry(agent):
    """The whole point of the registry: `prompt_reference` must name something
    real, not the unfalsifiable string "N/A"."""
    ref = agent.prompt_reference
    assert ref, f"{agent.name} has an empty prompt_reference"
    assert get_prompt(ref) is not None, (
        f"{agent.name} references prompt '{ref}', which is not in the registry. "
        f"Known keys: {prompt_keys()}"
    )


@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_no_agent_still_says_n_a(agent):
    """Regression guard on the original state."""
    assert agent.prompt_reference.strip().upper() not in ("N/A", "NA", "NONE", ""), (
        f"{agent.name} still has a placeholder prompt_reference"
    )


# ---------------------------------------------------------------------------
# Registry integrity
# ---------------------------------------------------------------------------

def test_every_prompt_key_is_unique():
    keys = [e.key for e in all_prompts()]
    assert len(keys) == len(set(keys))


def test_every_entry_is_versioned():
    """Section 9 requires prompts to be VERSIONED. An unversioned prompt cannot
    be correlated with the decisions it produced."""
    for entry in all_prompts():
        assert entry.version, f"{entry.key} has no version"
        assert entry.version.count(".") == 2, f"{entry.key} version '{entry.version}' is not semver"


def test_every_entry_names_where_it_is_implemented():
    """A prompt with no implementation site cannot be found or changed."""
    for entry in all_prompts():
        assert entry.implemented_in.strip(), f"{entry.key} does not say where it is used"


def test_every_entry_cites_a_spec_section():
    for entry in all_prompts():
        assert entry.spec_section.strip(), f"{entry.key} cites no spec section"


def test_every_deterministic_entry_explains_why_it_has_no_prompt():
    """This is what stops the registry from being "N/A" with extra ceremony.

    A DETERMINISTIC entry is a recorded DECISION that a stage takes no model
    input. Without a reason it is just an absence again.
    """
    missing = [
        e.key for e in all_prompts()
        if e.kind == PromptKind.DETERMINISTIC and not (e.reason or "").strip()
    ]
    assert not missing, f"deterministic entries with no stated reason: {missing}"
    assert coverage()["deterministicWithoutReason"] == []


def test_every_model_prompt_has_actual_text():
    """A prompt entry with no text is a promise, not a prompt."""
    missing = [
        e.key for e in all_prompts()
        if e.kind in (PromptKind.REFLECTION, PromptKind.AGENT) and not e.text
    ]
    assert not missing, f"model-backed prompts with no text: {missing}"
    assert coverage()["modelPromptsWithoutText"] == []


def test_deterministic_entries_have_no_prompt_text():
    """A deterministic stage carrying prompt text would mean one of the two is
    wrong about what actually runs."""
    for entry in all_prompts():
        if entry.kind == PromptKind.DETERMINISTIC:
            assert entry.text is None, f"{entry.key} is deterministic but carries prompt text"


# ---------------------------------------------------------------------------
# Section 9's required prompt types
# ---------------------------------------------------------------------------

def test_master_prompt_is_registered():
    entry = get_prompt("MASTER_V1")
    assert entry is not None
    assert entry.kind == PromptKind.MASTER
    # Stored as CLAUDE.md rather than inline, because it must be the file the
    # coding agent reads automatically. Duplicating it would create drift.
    assert "CLAUDE.md" in entry.implemented_in


def test_reflection_prompt_is_registered_and_forbids_config_advice():
    """CLAUDE.md invariant 5 has to hold in the PROMPT too, not only in the code
    — a reflection prompt that invites a configuration change is inviting the
    model to start down the forbidden auto-deploy path."""
    entry = get_prompt("REFLECTION_V1")
    assert entry is not None
    assert "Do not recommend a configuration change" in entry.text


def test_reflection_prompt_forbids_inventing_data():
    entry = get_prompt("REFLECTION_V1")
    assert "Do not invent data" in entry.text


def test_hypothesis_prompt_requires_a_test_for_every_claim():
    """Section 12 requires a validation plan alongside every hypothesis. A claim
    with no test is an opinion."""
    entry = get_prompt("HYPOTHESIS_V1")
    assert entry is not None
    assert "TEST:" in entry.text
    assert "overfit" in entry.text.lower() or "one historical period" in entry.text


def test_collaboration_prompt_states_it_cannot_override_risk():
    """Section 16: a second opinion is a research input, never a bypass around
    the Risk or Supervisor layers."""
    entry = get_prompt("COLLABORATION_V1")
    assert entry is not None
    assert "advisory only" in entry.text
    assert "cannot override the risk layer" in entry.text


def test_collaboration_prompt_specifies_a_parseable_response_shape():
    """A free-form second opinion cannot be recorded or compared."""
    entry = get_prompt("COLLABORATION_V1")
    for field in ("RECOMMENDATION:", "CONFIDENCE:", "REASONING:"):
        assert field in entry.text


def test_debate_and_planner_prompts_are_registered_as_deterministic():
    """Section 9 lists debate and planner prompts. Both stages exist here and
    are deliberately computation — which is a recorded decision, not a gap."""
    for key in ("DEBATE_DETERMINISTIC_V1", "PLANNER_DETERMINISTIC_V1"):
        entry = get_prompt(key)
        assert entry is not None, f"{key} missing"
        assert entry.kind == PromptKind.DETERMINISTIC
        assert entry.reason


def test_debate_reason_explains_the_reproducibility_argument():
    """The reason a financial decision rule must not be a model call: the same
    candles have to yield the same verdict or it cannot be backtested."""
    entry = get_prompt("DEBATE_DETERMINISTIC_V1")
    assert "reproducible" in entry.reason or "backtest" in entry.reason


# ---------------------------------------------------------------------------
# Section 22's ten domain prompts
# ---------------------------------------------------------------------------

def test_all_ten_section_22_domain_prompts_are_recorded():
    assert len(DOMAIN_PROMPTS) == 10, f"expected 10 domain prompts, found {len(DOMAIN_PROMPTS)}"


def test_domain_prompts_are_numbered_to_match_the_spec():
    for i in range(1, 11):
        expected = f"22.{i} "
        assert any(k.startswith(expected) for k in DOMAIN_PROMPTS), (
            f"no domain prompt for spec section 22.{i}"
        )


def test_risk_domain_prompt_states_constraints_are_enforced_in_code():
    """Section 22.3's distinguishing requirement: hard constraints enforced in
    code, not recommended. A veto that could be talked out of is not a veto."""
    text = DOMAIN_PROMPTS["22.3 Risk Engine"]
    assert "in code" in text
    assert "veto" in text.lower()


def test_research_domain_prompt_states_the_human_approval_requirement():
    text = DOMAIN_PROMPTS["22.5 Research Lab"]
    assert "human approval" in text.lower()


def test_infrastructure_domain_prompt_names_the_specific_worst_case():
    """Section 22.8 is explicit that the worst case is not a bad trade but going
    silent while holding a leveraged position."""
    text = DOMAIN_PROMPTS["22.8 Infrastructure"]
    assert "silent" in text.lower()
    assert "leveraged" in text.lower()


def test_qa_domain_prompt_prioritises_safety_tests():
    text = DOMAIN_PROMPTS["22.9 Testing & QA"]
    assert "safety" in text.lower()


# ---------------------------------------------------------------------------
# Coverage report
# ---------------------------------------------------------------------------

def test_coverage_report_is_complete():
    report = coverage()
    assert report["total"] == len(all_prompts())
    assert report["domainPrompts"] == 10
    assert report["deterministicWithoutReason"] == []
    assert report["modelPromptsWithoutText"] == []
    # Every Section 9 prompt type is represented.
    kinds = set(report["byKind"])
    for required in ("master", "reflection", "agent", "deterministic"):
        assert required in kinds, f"no prompt of kind '{required}' registered"
