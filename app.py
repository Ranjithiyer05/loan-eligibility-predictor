"""Flask web app for real-time loan eligibility prediction.

Run from the project root:
    python app.py
then open http://127.0.0.1:5000
"""
from flask import Flask, jsonify, render_template, request

from src.insights import get_insights
from src.predict import landscape, predict

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html", insights=get_insights())


@app.route("/api/predict", methods=["POST"])
def api_predict():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send a JSON object with the application fields"}), 400
    detailed = request.args.get("explain", "1") != "0"
    try:
        return jsonify(predict(data, detailed=detailed))
    except (ValueError, TypeError) as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/landscape", methods=["POST"])
def api_landscape():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send a JSON object with the application fields"}), 400
    try:
        return jsonify(landscape(data))
    except (ValueError, TypeError) as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/insights")
def api_insights():
    return jsonify(get_insights())


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    import os
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)), debug=os.environ.get("FLASK_DEBUG") == "1")
