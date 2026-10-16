"""Data loading, feature engineering and the preprocessing pipeline.

Preprocessing covers the three steps listed in the project description:
missing value handling, feature scaling and categorical encoding. Everything
lives inside a scikit-learn Pipeline so the exact same transforms are applied
at training time and when the Flask app makes a prediction.
"""
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer, OneHotEncoder, StandardScaler

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "loan_data.csv"

TARGET = "Loan_Status"

# Raw columns a user supplies (in the web form or the JSON API)
RAW_FEATURES = [
    "Gender", "Married", "Dependents", "Education", "Self_Employed",
    "ApplicantIncome", "CoapplicantIncome", "LoanAmount", "Loan_Amount_Term",
    "Credit_History", "Property_Area",
]

CATEGORICAL = ["Gender", "Married", "Dependents", "Education", "Self_Employed",
               "Property_Area", "Credit_History"]
NUMERIC = ["ApplicantIncome", "CoapplicantIncome", "LoanAmount", "Loan_Amount_Term"]
ENGINEERED = ["TotalIncome_log", "LoanAmount_log", "EMI", "Balance_Income", "Loan_Income_Ratio"]


def load_data(path=DATA_PATH):
    """Read the CSV and return (X, y) with y as 1 = approved, 0 = rejected."""
    df = pd.read_csv(path)
    df = df.drop(columns=["Loan_ID"], errors="ignore")
    y = (df[TARGET] == "Y").astype(int)
    X = df[RAW_FEATURES].copy()
    return X, y


def clean_raw(X):
    """Normalise raw input types so form, API and CSV data look the same."""
    X = X.copy()
    for col in NUMERIC:
        X[col] = pd.to_numeric(X[col], errors="coerce")
    # Credit_History is a 1/0 flag; treat it as a category so a missing value
    # gets the most frequent class rather than a fractional mean.
    X["Credit_History"] = pd.to_numeric(X["Credit_History"], errors="coerce")
    X["Credit_History"] = X["Credit_History"].map({1.0: "1", 0.0: "0"})
    for col in CATEGORICAL:
        X[col] = X[col].astype(object).where(X[col].notna(), np.nan)
    return X


def add_features(X):
    """Domain features used by lenders: total income, EMI and affordability."""
    X = X.copy()
    loan_amount = X["LoanAmount"].fillna(X["LoanAmount"].median())
    term = X["Loan_Amount_Term"].fillna(360).replace(0, 360)
    total_income = X["ApplicantIncome"].fillna(0) + X["CoapplicantIncome"].fillna(0)

    X["TotalIncome_log"] = np.log1p(total_income)
    X["LoanAmount_log"] = np.log1p(loan_amount)
    # LoanAmount is in thousands, so EMI is in the same units as monthly income
    X["EMI"] = loan_amount * 1000 / term
    X["Balance_Income"] = total_income - X["EMI"]
    X["Loan_Income_Ratio"] = loan_amount * 1000 / total_income.replace(0, np.nan)
    return X


def _prepare(X):
    return add_features(clean_raw(X))


def build_preprocessor():
    """Imputation + scaling for numbers, imputation + one-hot for categories."""
    numeric_pipe = Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
    ])
    categorical_pipe = Pipeline([
        ("impute", SimpleImputer(strategy="most_frequent")),
        ("encode", OneHotEncoder(handle_unknown="ignore", drop="if_binary")),
    ])
    columns = ColumnTransformer([
        ("num", numeric_pipe, NUMERIC + ENGINEERED),
        ("cat", categorical_pipe, CATEGORICAL),
    ])
    return Pipeline([
        ("features", FunctionTransformer(_prepare, validate=False)),
        ("columns", columns),
    ])
