"""Load the trained model, score a loan application and explain the result.

Command-line use from the project root:
    python -m src.predict --income 5000 --coincome 1500 --loan 128 --credit 1
"""
import argparse
from functools import lru_cache

import joblib
import numpy as np
import pandas as pd

from src.preprocess import RAW_FEATURES, load_data
from src.train import MODEL_PATH

DEFAULTS = {
    "Gender": "Male", "Married": "Yes", "Dependents": "0", "Education": "Graduate",
    "Self_Employed": "No", "CoapplicantIncome": 0, "Loan_Amount_Term": 360,
    "Property_Area": "Semiurban",
}
REQUIRED = ["ApplicantIncome", "LoanAmount", "Credit_History"]
ANNUAL_RATE = 0.09
NUMERIC_INPUTS = ["ApplicantIncome", "CoapplicantIncome", "LoanAmount", "Loan_Amount_Term"]

# Model features grouped into factors a person understands
FACTOR_GROUPS = {
    "Credit history": ["Credit_History"],
    "Household income": ["ApplicantIncome", "CoapplicantIncome", "TotalIncome_log", "Balance_Income"],
    "Loan size": ["LoanAmount", "LoanAmount_log", "EMI", "Loan_Income_Ratio"],
    "Loan term": ["Loan_Amount_Term"],
    "Property area": ["Property_Area"],
    "Marital status": ["Married"],
    "Education": ["Education"],
    "Dependents": ["Dependents"],
    "Employment type": ["Self_Employed"],
    "Gender": ["Gender"],
}


@lru_cache(maxsize=1)
def get_model():
    if not MODEL_PATH.exists():
        raise FileNotFoundError("Model not found. Train it first with: python -m src.train")
    return joblib.load(MODEL_PATH)


@lru_cache(maxsize=1)
def _explainer():
    """Coefficients, the average applicant (in model space) and feature to factor map."""
    model = get_model()
    prep, clf = model.named_steps["prep"], model.named_steps["model"]
    X, _ = load_data()
    baseline = prep.transform(X).mean(axis=0)
    names = prep.named_steps["columns"].get_feature_names_out()
    factor_of = []
    for name in names:
        base = name.split("__", 1)[1]
        factor_of.append(next(f for f, cols in FACTOR_GROUPS.items()
                              if any(base == c or base.startswith(c + "_") for c in cols)))
    return prep, clf.coef_[0], np.asarray(baseline).ravel(), factor_of


def _to_row(application):
    missing = [f for f in REQUIRED if application.get(f) in (None, "")]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")
    row = {f: application.get(f, DEFAULTS.get(f)) for f in RAW_FEATURES}
    row = {k: (DEFAULTS.get(k) if v in ("", None) else v) for k, v in row.items()}
    for f in NUMERIC_INPUTS:
        try:
            row[f] = float(row[f])
        except (TypeError, ValueError):
            raise ValueError(f"{f} must be a number")
        if row[f] < 0:
            raise ValueError(f"{f} cannot be negative")
    if row["LoanAmount"] == 0:
        raise ValueError("LoanAmount must be greater than zero")
    return row


def _probability(row):
    return float(get_model().predict_proba(pd.DataFrame([row]))[0, 1])


def explain(row):
    """Each factor's push on the log-odds compared with the average applicant."""
    prep, coef, baseline, factor_of = _explainer()
    x = np.asarray(prep.transform(pd.DataFrame([row]))).ravel()
    contrib = (x - baseline) * coef
    totals = {}
    for factor, value in zip(factor_of, contrib):
        totals[factor] = totals.get(factor, 0.0) + float(value)
    factors = [{"factor": f, "impact": round(v, 4)} for f, v in totals.items()]
    return sorted(factors, key=lambda d: abs(d["impact"]), reverse=True)


def suggestions(row, proba):
    """What-if scenarios that would most improve the approval odds."""
    scenarios = []
    if str(row["Credit_History"]) in ("0", "0.0"):
        scenarios.append(("Build a credit history that meets guidelines", {"Credit_History": 1}))
    scenarios.append(("Borrow 25% less", {"LoanAmount": round(row["LoanAmount"] * 0.75)}))
    if row["Loan_Amount_Term"] < 360:
        scenarios.append(("Stretch the term to 360 months", {"Loan_Amount_Term": 360}))
    scenarios.append(("Add a co-applicant earning 2,000 more",
                      {"CoapplicantIncome": row["CoapplicantIncome"] + 2000}))
    out = []
    for label, change in scenarios:
        new = _probability({**row, **change})
        if new - proba > 0.005:
            out.append({"label": label, "change": change, "new_probability": round(new, 4),
                        "delta": round(new - proba, 4)})
    return sorted(out, key=lambda d: d["delta"], reverse=True)[:3]


INCOME_AXIS = list(range(0, 25001, 1000))
LOAN_AXIS = list(range(25, 601, 25))
INCOME_CURVE = list(range(0, 25001, 500))
LOAN_CURVE = list(range(10, 601, 10))


def _batch(rows):
    return [round(float(p), 4) for p in get_model().predict_proba(pd.DataFrame(rows))[:, 1]]


def landscape(application):
    """Approval odds across income and loan size, holding everything else fixed."""
    row = _to_row(application)
    grid = _batch([{**row, "ApplicantIncome": i, "LoanAmount": l} for l in LOAN_AXIS for i in INCOME_AXIS])
    width = len(INCOME_AXIS)
    return {
        "income_axis": INCOME_AXIS,
        "loan_axis": LOAN_AXIS,
        "grid": [grid[k:k + width] for k in range(0, len(grid), width)],
        "income_curve": {"x": INCOME_CURVE, "p": _batch([{**row, "ApplicantIncome": i} for i in INCOME_CURVE])},
        "loan_curve": {"x": LOAN_CURVE, "p": _batch([{**row, "LoanAmount": l} for l in LOAN_CURVE])},
    }


def predict(application, detailed=False):
    """Return the decision and approval probability for one application dict."""
    row = _to_row(application)
    proba = _probability(row)
    result = {
        "eligible": proba >= 0.5,
        "decision": "Approved" if proba >= 0.5 else "Rejected",
        "approval_probability": round(proba, 4),
    }
    if detailed:
        term = row["Loan_Amount_Term"] or 360
        income = row["ApplicantIncome"] + row["CoapplicantIncome"]
        # Display EMI uses the standard amortisation formula at a typical home loan rate
        r = ANNUAL_RATE / 12
        emi = row["LoanAmount"] * 1000 * r * (1 + r) ** term / ((1 + r) ** term - 1)
        result.update({
            "factors": explain(row),
            "suggestions": suggestions(row, proba),
            "affordability": {
                "emi": round(emi, 2),
                "total_income": income,
                "emi_to_income": round(emi / income, 4) if income else None,
                "annual_rate": ANNUAL_RATE,
            },
        })
    return result


def main():
    p = argparse.ArgumentParser(description="Predict loan eligibility")
    p.add_argument("--income", type=float, required=True, help="Applicant monthly income")
    p.add_argument("--coincome", type=float, default=0, help="Co-applicant monthly income")
    p.add_argument("--loan", type=float, required=True, help="Loan amount in thousands")
    p.add_argument("--term", type=float, default=360, help="Loan term in months")
    p.add_argument("--credit", type=int, choices=[0, 1], required=True,
                   help="1 if credit history meets guidelines, else 0")
    p.add_argument("--married", default="Yes", choices=["Yes", "No"])
    p.add_argument("--education", default="Graduate", choices=["Graduate", "Not Graduate"])
    p.add_argument("--area", default="Semiurban", choices=["Urban", "Semiurban", "Rural"])
    a = p.parse_args()

    result = predict({
        "ApplicantIncome": a.income, "CoapplicantIncome": a.coincome, "LoanAmount": a.loan,
        "Loan_Amount_Term": a.term, "Credit_History": a.credit, "Married": a.married,
        "Education": a.education, "Property_Area": a.area,
    }, detailed=True)
    print(f"{result['decision']} (approval probability {result['approval_probability']:.1%})")
    print("Top factors:")
    for f in result["factors"][:4]:
        print(f"  {f['factor']:20s} {'helps' if f['impact'] > 0 else 'hurts'} ({f['impact']:+.2f})")
    for s in result["suggestions"]:
        print(f"  Tip: {s['label']} -> {s['new_probability']:.1%}")


if __name__ == "__main__":
    main()
