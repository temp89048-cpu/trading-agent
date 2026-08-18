"""LangGraph cognitive plane (spec Section 36).

No module in this package may import the execution engine, the exchange client,
or the TAR event types. Enforced by tests/test_graph_contracts.py — see
backend/graphs/contracts.py::FORBIDDEN_IMPORTS for the list and the reasoning.
"""
