from typing import Optional, Sequence

import numpy as np
import networkx as nx

def calculate_correlation_matrix(returns_matrix: np.ndarray) -> np.ndarray:
    """
    Calculates the Pearson correlation matrix for N assets.
    returns_matrix: Shape (N_assets, Time_periods)
    """
    return np.corrcoef(returns_matrix)


def pearson_correlation(a: Sequence[float], b: Sequence[float]) -> Optional[float]:
    """Pearson correlation of two series, or None when it cannot be computed.

    WHY NOT JUST `np.corrcoef`: for a constant series the variance is zero and
    corrcoef returns `nan` (with a RuntimeWarning). `nan` then propagates
    silently through every comparison — `abs(nan) > 0.75` is False, so an
    unmeasurable pair reads as *uncorrelated* and passes an exposure check it
    should have failed. Returning None forces the caller to decide, and
    `agents/cio_agent.py` deliberately treats None as correlated.

    None means "not measured". 0.0 means "measured, and they do not move
    together". Those are different facts and the distinction matters for
    position sizing.

    Lives here rather than in the CIO agent so there is one correlation
    implementation (spec Section 20: "never duplicate logic").
    """
    n = min(len(a), len(b))
    if n < 2:
        return None
    # Align on the most recent n points: two symbols can have different history
    # lengths, and zipping from the start would compare last week's returns for
    # one against yesterday's for the other.
    x = np.asarray(a[-n:], dtype=float)
    y = np.asarray(b[-n:], dtype=float)

    if not (np.all(np.isfinite(x)) and np.all(np.isfinite(y))):
        return None

    var_x = float(np.var(x))
    var_y = float(np.var(y))
    if var_x <= 0 or var_y <= 0:
        # A flat series has no correlation to measure, not zero correlation.
        return None

    mean_x = float(np.mean(x))
    mean_y = float(np.mean(y))
    cov = float(np.sum((x - mean_x) * (y - mean_y)))
    denom = float(np.sqrt(np.sum((x - mean_x) ** 2) * np.sum((y - mean_y) ** 2)))
    if denom == 0:
        return None
    result = cov / denom
    # Clamp: floating-point error can produce 1.0000000000000002, which then
    # fails any `-1 <= r <= 1` assertion downstream.
    return max(-1.0, min(1.0, result))

def build_asset_graph(symbols: list[str], correlation_matrix: np.ndarray, threshold: float = 0.7) -> nx.Graph:
    """
    Builds a NetworkX graph to represent highly correlated assets (Graph Intelligence).
    Used to detect clustering risks.
    """
    G = nx.Graph()
    G.add_nodes_from(symbols)
    
    n = len(symbols)
    for i in range(n):
        for j in range(i+1, n):
            if abs(correlation_matrix[i, j]) >= threshold:
                G.add_edge(symbols[i], symbols[j], weight=correlation_matrix[i, j])
                
    return G

def optimize_portfolio_weights_naive(expected_returns: np.ndarray, cov_matrix: np.ndarray, risk_aversion: float = 2.0) -> np.ndarray:
    """
    Extremely simplified Mean-Variance Optimization.
    Returns pseudo-optimal weights.
    """
    # W = (Cov)^-1 * Expected_Returns / risk_aversion
    try:
        inv_cov = np.linalg.inv(cov_matrix)
        weights = inv_cov.dot(expected_returns) / risk_aversion
        
        # Normalize to sum to 1.0 (assuming fully invested, no shorting for simplicity)
        weights = np.maximum(weights, 0)
        if np.sum(weights) > 0:
            weights = weights / np.sum(weights)
        return weights
    except np.linalg.LinAlgError:
        # Fallback to equal weight if matrix is singular
        n = len(expected_returns)
        return np.ones(n) / n
