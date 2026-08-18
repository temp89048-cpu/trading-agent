from typing import Dict, Any, List, Optional
from backend.prompts.registry import get_prompt, all_prompts, PromptKind, DOMAIN_PROMPTS

class ProceduralMemory:
    """
    Procedural Memory (Section 15, Phase 32).
    
    This service allows agents to look up their operational instructions, rules, 
    and prompt templates from the registry. Instead of hardcoding instructions inside
    the LangGraph nodes, agents query Procedural Memory to find out *how* they should operate.
    """
    
    @staticmethod
    def get_instruction(key: str) -> Optional[Dict[str, Any]]:
        """Retrieve a specific operational instruction (prompt entry) by key."""
        entry = get_prompt(key)
        if not entry:
            return None
        return {
            "key": entry.key,
            "version": entry.version,
            "kind": entry.kind.value,
            "summary": entry.summary,
            "text": entry.text,
            "reason_if_deterministic": entry.reason,
            "spec_section": entry.spec_section,
        }

    @staticmethod
    def get_all_instructions() -> List[Dict[str, Any]]:
        """Retrieve all operational instructions."""
        instructions = []
        for entry in all_prompts():
            instructions.append({
                "key": entry.key,
                "version": entry.version,
                "kind": entry.kind.value,
                "summary": entry.summary,
            })
        return instructions
        
    @staticmethod
    def get_domain_prompt(domain_key: str) -> Optional[str]:
        """Retrieve a domain-specific engineering prompt."""
        return DOMAIN_PROMPTS.get(domain_key)
