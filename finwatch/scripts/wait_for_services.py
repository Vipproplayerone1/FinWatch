"""Wait for services to be ready, then register Debezium connector."""

import time
import json
import requests
import sys
from pathlib import Path


def wait_for_url(url: str, name: str, timeout: int = 120):
    """Wait for a URL to respond with HTTP 200."""
    print(f"[..] Waiting for {name} at {url}...")
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code < 500:
                print(f"[OK] {name} is ready!")
                return True
        except requests.ConnectionError:
            pass
        time.sleep(3)
    print(f"[FAIL] {name} not ready after {timeout}s")
    return False


def register_connector(connect_url: str, config_path: str):
    """Register a Debezium connector."""
    with open(config_path) as f:
        connector_config = json.load(f)

    name = connector_config["name"]

    # Check if already exists
    r = requests.get(f"{connect_url}/connectors/{name}")
    if r.status_code == 200:
        print(f"[..] Connector '{name}' exists. Updating...")
        r = requests.put(
            f"{connect_url}/connectors/{name}/config",
            headers={"Content-Type": "application/json"},
            json=connector_config["config"],
        )
    else:
        print(f"[..] Registering connector '{name}'...")
        r = requests.post(
            f"{connect_url}/connectors",
            headers={"Content-Type": "application/json"},
            json=connector_config,
        )

    if r.status_code in (200, 201):
        print(f"[OK] Connector '{name}' registered successfully!")
    else:
        print(f"[FAIL] Failed: {r.status_code} - {r.text}")
        sys.exit(1)

    # Verify status
    time.sleep(5)
    r = requests.get(f"{connect_url}/connectors/{name}/status")
    status = r.json()
    state = status.get("connector", {}).get("state", "UNKNOWN")
    print(f"[--] Connector state: {state}")
    if state != "RUNNING":
        print(f"[WARN] Connector is {state}, not RUNNING")
        print(json.dumps(status, indent=2))


if __name__ == "__main__":
    services = [
        ("http://localhost:5432", None),  # skip TCP check for PG
        ("http://localhost:8083/connectors", "Debezium Connect"),
    ]

    wait_for_url("http://localhost:8083/connectors", "Debezium Connect", timeout=180)
    register_connector(
        "http://localhost:8083",
        "debezium/connectors/finwatch-connector.json",
    )
