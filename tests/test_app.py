"""Smoke tests for the model and the Flask app. Run with: python -m pytest"""
import pytest

from app import app
from src.predict import predict

GOOD = {"ApplicantIncome": 5000, "CoapplicantIncome": 1500, "LoanAmount": 128,
        "Credit_History": 1, "Married": "Yes", "Property_Area": "Semiurban"}


def test_good_credit_scores_higher_than_bad_credit():
    good = predict(GOOD)
    bad = predict({**GOOD, "Credit_History": 0})
    assert good["approval_probability"] > bad["approval_probability"]
    assert 0 <= bad["approval_probability"] <= 1


def test_missing_required_field_is_rejected():
    with pytest.raises(ValueError):
        predict({"ApplicantIncome": 5000})


def test_api_predict():
    client = app.test_client()
    resp = client.post("/api/predict", json=GOOD)
    assert resp.status_code == 200
    assert resp.get_json()["decision"] in ("Approved", "Rejected")
    assert client.post("/api/predict", json={}).status_code == 400


def test_explanation_and_suggestions():
    result = predict({**GOOD, "Credit_History": 0}, detailed=True)
    factors = {f["factor"]: f["impact"] for f in result["factors"]}
    assert factors["Credit history"] < 0
    assert result["suggestions"][0]["new_probability"] > result["approval_probability"]
    assert result["affordability"]["emi"] > 0


def test_pages_and_insights():
    client = app.test_client()
    resp = client.get("/")
    assert resp.status_code == 200 and b"LoanSense" in resp.data
    data = client.get("/api/insights").get_json()
    assert data["dataset"]["rows"] == 614 and data["segments"]


def test_landscape():
    client = app.test_client()
    data = client.post("/api/landscape", json=GOOD).get_json()
    assert len(data["grid"]) == len(data["loan_axis"])
    assert len(data["grid"][0]) == len(data["income_axis"])
    assert all(0 <= p <= 1 for p in data["loan_curve"]["p"])
