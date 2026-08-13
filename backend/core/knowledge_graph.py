from typing import Dict, List, Any
import networkx as nx
import logging

logger = logging.getLogger(__name__)

class KnowledgeGraph:
    """
    Level 4: Knowledge Graph
    Instead of simple memory, the AI should understand relationships.
    e.g., High Funding -> High Liq Risk -> Lower Position Size
    """
    def __init__(self):
        self.graph = nx.DiGraph()
        self._initialize_base_rules()

    def _initialize_base_rules(self):
        # Base trading logic rules stored as graph relationships
        self.add_relationship("High Funding", "High Liquidation Risk", weight=0.8)
        self.add_relationship("High Liquidation Risk", "Lower Position Size", weight=1.0)
        
        self.add_relationship("Trending Bullish", "Trend Following Strategy", weight=0.9)
        self.add_relationship("Ranging", "Mean Reversion Strategy", weight=0.9)
        
    def add_relationship(self, source: str, target: str, weight: float = 1.0):
        self.graph.add_edge(source, target, weight=weight)
        
    def query_implications(self, state: str) -> List[str]:
        """Query what a certain market state implies."""
        if state not in self.graph:
            return []
            
        implications = []
        # Get immediate neighbors
        for neighbor in self.graph.successors(state):
            implications.append(neighbor)
            # Get 2nd degree implications
            for secondary in self.graph.successors(neighbor):
                if secondary not in implications:
                    implications.append(secondary)
                    
        return implications

_kg = KnowledgeGraph()

def get_knowledge_graph() -> KnowledgeGraph:
    return _kg
