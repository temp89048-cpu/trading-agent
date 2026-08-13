def bayesian_update(prior: float, likelihood_evidence_given_regime: float, likelihood_evidence_given_not_regime: float) -> float:
    """
    Applies Bayes' Theorem to update the probability of a market regime.
    prior: P(Regime)
    """
    # P(Evidence) = P(Evidence|Regime) * P(Regime) + P(Evidence|Not Regime) * P(Not Regime)
    p_evidence = (likelihood_evidence_given_regime * prior) + (likelihood_evidence_given_not_regime * (1.0 - prior))
    
    if p_evidence == 0:
        return prior
        
    # P(Regime|Evidence) = (P(Evidence|Regime) * P(Regime)) / P(Evidence)
    posterior = (likelihood_evidence_given_regime * prior) / p_evidence
    return posterior

def calibrate_confidence(raw_confidence: float, historical_accuracy: float, volatility_penalty: float) -> float:
    """
    Scales a raw confidence score (e.g. from the Debate Judge) based on agent track record
    and current market conditions.
    """
    # Base calibration
    calibrated = raw_confidence * historical_accuracy
    
    # Apply penalty for high volatility environments
    calibrated = calibrated * (1.0 - volatility_penalty)
    
    return max(0.0, min(1.0, calibrated))
