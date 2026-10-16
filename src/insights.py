"""Dataset and model statistics shown in the app's insights section."""
import json
from functools import lru_cache

import pandas as pd

from src.preprocess import DATA_PATH
from src.train import METRICS_PATH

SEGMENTS = {
    "Credit_History": ("Credit history", {1.0: "Meets guidelines", 0.0: "Does not meet"}),
    "Property_Area": ("Property area", None),
    "Married": ("Marital status", {"Yes": "Married", "No": "Single"}),
    "Education": ("Education", None),
}


@lru_cache(maxsize=1)
def get_insights():
    df = pd.read_csv(DATA_PATH)
    df["approved"] = (df["Loan_Status"] == "Y").astype(int)
    segments = []
    for col, (title, labels) in SEGMENTS.items():
        grouped = df.dropna(subset=[col]).groupby(col)["approved"].agg(["mean", "count"])
        rows = [{"label": (labels or {}).get(k, str(k)), "rate": round(float(r["mean"]), 4),
                 "count": int(r["count"])} for k, r in grouped.iterrows()]
        segments.append({"title": title, "rows": sorted(rows, key=lambda r: -r["rate"])})
    metrics = json.loads(METRICS_PATH.read_text()) if METRICS_PATH.exists() else None
    return {
        "dataset": {
            "rows": len(df),
            "approval_rate": round(float(df["approved"].mean()), 4),
            "median_income": float(df["ApplicantIncome"].median()),
            "median_loan": float(df["LoanAmount"].median()),
        },
        "segments": segments,
        "metrics": metrics,
    }
