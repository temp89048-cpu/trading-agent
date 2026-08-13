from typing import Dict, Any, List
import json

class ContextBuilder:
    """
    Level 5: Model Context Management
    Prevent the LLM from receiving everything every time. Build context deliberately.
    """
    
    @staticmethod
    def build_prompt_context(symbol: str, klines: List[Dict], news: List[Dict], memory: List[Dict]) -> str:
        """Prunes raw data to only what is relevant to the LLM prompt."""
        
        # 1. Prune Klines (Only need last 5 for immediate structure, rather than 100)
        recent_klines = klines[-5:] if len(klines) >= 5 else klines
        
        # 2. Prune News (Only keep titles and sentiment, discard full text)
        relevant_news = [{"title": n.get("title", ""), "sentiment": n.get("sentiment", "neutral")} for n in news]
        
        # 3. Prune Memory (Only keep trades for THIS symbol)
        symbol_memory = [m for m in memory if m.get("symbol") == symbol][-3:] # Last 3 trades
        
        context = {
            "symbol": symbol,
            "recent_price_action": recent_klines,
            "relevant_news": relevant_news,
            "recent_memory": symbol_memory
        }
        
        return json.dumps(context, indent=2)

def get_context_builder() -> ContextBuilder:
    return ContextBuilder()
