"""Tests for pipeline health verification."""

import requests
import subprocess


def test_postgres_healthy():
    result = subprocess.run(
        ["docker", "exec", "finwatch-postgres", "pg_isready", "-U", "finwatch"],
        capture_output=True, text=True
    )
    assert result.returncode == 0


def test_kafka_healthy():
    result = subprocess.run(
        ["docker", "exec", "finwatch-kafka", "kafka-topics",
         "--bootstrap-server", "kafka:9092", "--list"],
        capture_output=True, text=True
    )
    assert result.returncode == 0


def test_debezium_connector_running():
    r = requests.get("http://localhost:8083/connectors/finwatch-connector/status")
    assert r.status_code == 200
    status = r.json()
    assert status["connector"]["state"] == "RUNNING"
    assert status["tasks"][0]["state"] == "RUNNING"


def test_clickhouse_healthy():
    r = requests.get("http://localhost:8123/ping")
    assert r.status_code == 200
    assert r.text.strip() == "Ok."


def test_grafana_healthy():
    r = requests.get("http://localhost:3000/api/health")
    assert r.status_code == 200
    assert r.json()["database"] == "ok"


def test_prometheus_healthy():
    r = requests.get("http://localhost:9090/-/healthy")
    assert r.status_code == 200
