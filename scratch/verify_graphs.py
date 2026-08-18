import sys
import os

# Add the project root to the python path so imports work correctly
sys.path.insert(0, os.path.abspath('.'))

from backend.graphs.market_state import market_state_config
from backend.graphs.builder import build_graph
from backend.graphs.strategy_selection_graph import build_strategy_selection_graph
from backend.graphs.research_graph import build_research_graph
from backend.graphs.reflection_graph import build_reflection_graph
from backend.graphs.execution_graph import build_execution_graph

def verify_all_graphs():
    success = True
    print("Verifying LangGraph implementations...\n")

    # 1. Market State Graph
    try:
        from backend.graphs.runtime import RunContext
        from backend.llm.budget import RunBudget
        from backend.graphs.tracing import RunTrace
        import time
        ctx = RunContext(run_id="test", graph="market", budget=RunBudget(max_tokens=1000), trace=RunTrace(run_id="test", graph="market", symbol="BTC-USDT", thread_id="test-thread", started_at=time.time(), trigger="test"))
        config = market_state_config()
        market_graph = build_graph(config, ctx)
        print("PASS - Market State Graph successfully configured and compiled.")
    except Exception as e:
        print(f"FAIL - Failed to build Market State Graph: {e}")
        success = False

    # 2. Strategy Selection Graph
    try:
        strategy_graph = build_strategy_selection_graph()
        print("PASS - Strategy Selection Graph successfully configured and compiled.")
    except Exception as e:
        print(f"FAIL - Failed to build Strategy Selection Graph: {e}")
        success = False

    # 3. Research Graph
    try:
        research_graph = build_research_graph()
        print("PASS - Research Graph successfully configured and compiled.")
    except Exception as e:
        print(f"FAIL - Failed to build Research Graph: {e}")
        success = False

    # 4. Reflection Graph
    try:
        reflection_graph = build_reflection_graph()
        print("PASS - Reflection Graph successfully configured and compiled.")
    except Exception as e:
        print(f"FAIL - Failed to build Reflection Graph: {e}")
        success = False

    # 5. Execution Graph
    try:
        execution_graph = build_execution_graph()
        print("PASS - Execution Graph successfully configured and compiled.")
    except Exception as e:
        print(f"FAIL - Failed to build Execution Graph: {e}")
        success = False

    print("\nVerification Complete.")
    if success:
        print("ALL LangGraphs are fully implemented and compile without errors!")
    else:
        print("WARNING: Some graphs failed to compile. See errors above.")

if __name__ == "__main__":
    verify_all_graphs()
