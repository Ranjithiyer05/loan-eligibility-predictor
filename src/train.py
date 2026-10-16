"""Train and evaluate the loan eligibility model.

Run from the project root:
    python -m src.train

Logistic Regression is the deployed model. A Decision Tree and a Random Forest
are cross-validated alongside it as baselines so the choice is backed by numbers.
"""
import json

import joblib
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix,
                             f1_score, precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import GridSearchCV, StratifiedKFold, cross_validate, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.tree import DecisionTreeClassifier

from src.preprocess import ROOT, build_preprocessor, load_data

MODEL_PATH = ROOT / "models" / "loan_model.joblib"
METRICS_PATH = ROOT / "reports" / "metrics.json"
RANDOM_STATE = 42


def make_pipeline(model):
    return Pipeline([("prep", build_preprocessor()), ("model", model)])


def compare_baselines(X, y, cv):
    candidates = {
        "logistic_regression": LogisticRegression(max_iter=1000),
        "decision_tree": DecisionTreeClassifier(max_depth=4, random_state=RANDOM_STATE),
        "random_forest": RandomForestClassifier(n_estimators=300, max_depth=6,
                                                random_state=RANDOM_STATE),
    }
    results = {}
    for name, model in candidates.items():
        scores = cross_validate(make_pipeline(model), X, y, cv=cv,
                                scoring=["accuracy", "f1", "roc_auc"])
        results[name] = {m: round(scores[f"test_{m}"].mean(), 4)
                         for m in ("accuracy", "f1", "roc_auc")}
        print(f"{name:20s} acc={results[name]['accuracy']:.3f} "
              f"f1={results[name]['f1']:.3f} auc={results[name]['roc_auc']:.3f}")
    return results


def main():
    X, y = load_data()
    print(f"Loaded {len(X)} applications ({y.mean():.1%} approved)")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=RANDOM_STATE)
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)

    print("\n5-fold cross-validation on the training set:")
    baselines = compare_baselines(X_train, y_train, cv)

    # Tune the regularisation strength of the Logistic Regression
    search = GridSearchCV(
        make_pipeline(LogisticRegression(max_iter=1000)),
        param_grid={"model__C": [0.01, 0.1, 1, 10], "model__class_weight": [None, "balanced"]},
        scoring="roc_auc", cv=cv,
    )
    search.fit(X_train, y_train)
    model = search.best_estimator_
    print(f"\nBest Logistic Regression params: {search.best_params_}")

    pred = model.predict(X_test)
    proba = model.predict_proba(X_test)[:, 1]
    test_metrics = {
        "accuracy": round(accuracy_score(y_test, pred), 4),
        "precision": round(precision_score(y_test, pred), 4),
        "recall": round(recall_score(y_test, pred), 4),
        "f1": round(f1_score(y_test, pred), 4),
        "roc_auc": round(roc_auc_score(y_test, proba), 4),
        "confusion_matrix": confusion_matrix(y_test, pred).tolist(),
    }
    print("\nHeld-out test set (20%):")
    print(classification_report(y_test, pred, target_names=["Rejected", "Approved"]))
    print(f"ROC-AUC: {test_metrics['roc_auc']:.3f}")

    # Coefficients show which factors push an application towards approval
    feature_names = model.named_steps["prep"].named_steps["columns"].get_feature_names_out()
    coefs = model.named_steps["model"].coef_[0]
    top = sorted(zip(feature_names, coefs), key=lambda t: abs(t[1]), reverse=True)[:8]
    print("Most influential features:")
    for name, c in top:
        print(f"  {name:35s} {c:+.3f}")

    # Refit on all data for the deployed model, using the tuned parameters
    final = make_pipeline(LogisticRegression(max_iter=1000))
    final.set_params(**search.best_params_)
    final.fit(X, y)

    MODEL_PATH.parent.mkdir(exist_ok=True)
    METRICS_PATH.parent.mkdir(exist_ok=True)
    joblib.dump(final, MODEL_PATH)
    METRICS_PATH.write_text(json.dumps({
        "dataset_rows": len(X),
        "cv_baselines": baselines,
        "best_params": search.best_params_,
        "test_set": test_metrics,
        "top_features": [{"feature": n, "coefficient": round(float(c), 4)} for n, c in top],
    }, indent=2))
    print(f"\nSaved model to {MODEL_PATH.relative_to(ROOT)} and metrics to "
          f"{METRICS_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
