#!/usr/bin/env python3
"""
GARCH(1,1) vol regime signal for Backbone Pro's 4th session-bar indicator.
Input (stdin):  {"closes": [252 daily closes, oldest→newest]}
Output (stdout): {"regime": "low_vol"|"high_vol"|"transitioning",
                   "forecast": <next-day annualised vol %>,
                   "current_vol": <trailing 20d annualised vol %>}

Deps: numpy, scipy (both on Railway's default python buildpack — no `arch`
package required, keeping this to a single lightweight script per the
original 60-line-Python note).
"""
import sys, json
import numpy as np
from scipy.optimize import minimize

def log_returns(closes):
    c = np.array(closes, dtype=float)
    return np.diff(np.log(c))

def garch11_negloglik(params, r):
    omega, alpha, beta = params
    n = len(r)
    sigma2 = np.empty(n)
    sigma2[0] = np.var(r)
    for t in range(1, n):
        sigma2[t] = omega + alpha * r[t-1]**2 + beta * sigma2[t-1]
    sigma2 = np.maximum(sigma2, 1e-12)
    ll = -0.5 * np.sum(np.log(2*np.pi*sigma2) + r**2 / sigma2)
    return -ll

def fit_garch11(r):
    var_r = np.var(r)
    x0 = [var_r * 0.05, 0.08, 0.88]  # typical starting values
    bounds = [(1e-10, None), (0, 1), (0, 1)]
    res = minimize(garch11_negloglik, x0, args=(r,), bounds=bounds, method='L-BFGS-B')
    return res.x  # omega, alpha, beta

def main():
    payload = json.load(sys.stdin)
    closes = payload.get('closes', [])
    if len(closes) < 60:
        print(json.dumps({"error": "need at least 60 closes for a stable GARCH fit"}))
        return

    r = log_returns(closes)
    omega, alpha, beta = fit_garch11(r)

    # rolling conditional variance to get current + forecast next-day vol
    sigma2 = np.empty(len(r))
    sigma2[0] = np.var(r)
    for t in range(1, len(r)):
        sigma2[t] = omega + alpha * r[t-1]**2 + beta * sigma2[t-1]
    forecast_var = omega + alpha * r[-1]**2 + beta * sigma2[-1]

    current_vol_annualised = float(np.sqrt(sigma2[-1] * 252) * 100)
    forecast_vol_annualised = float(np.sqrt(forecast_var * 252) * 100)

    # regime thresholds — long-run unconditional vol as the anchor
    long_run_var = omega / max(1e-9, (1 - alpha - beta)) if (alpha + beta) < 1 else np.mean(sigma2)
    long_run_vol = float(np.sqrt(long_run_var * 252) * 100)

    ratio = forecast_vol_annualised / long_run_vol if long_run_vol > 0 else 1.0
    if ratio < 0.85:
        regime = "low_vol"
    elif ratio > 1.25:
        regime = "high_vol"
    else:
        regime = "transitioning"

    print(json.dumps({
        "regime": regime,
        "forecast": round(forecast_vol_annualised, 2),
        "current_vol": round(current_vol_annualised, 2),
        "long_run_vol": round(long_run_vol, 2)
    }))

if __name__ == '__main__':
    main()
