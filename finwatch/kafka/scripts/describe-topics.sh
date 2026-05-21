#!/usr/bin/env bash
# ============================================================================
# describe-topics.sh
# ----------------------------------------------------------------------------
# Show partition, replica, and configuration detail for every FinWatch topic.
# Useful for verifying Debezium and ClickHouse Kafka Engine setup.
#
# Usage:
#     bash kafka/scripts/describe-topics.sh
# ============================================================================

set -euo pipefail

KAFKA_CONTAINER="${KAFKA_CONTAINER:-finwatch-kafka}"
BOOTSTRAP="${BOOTSTRAP:-kafka:9092}"

echo "===================================================================="
echo " Kafka cluster topics"
echo "===================================================================="
docker exec "$KAFKA_CONTAINER" kafka-topics \
  --bootstrap-server "$BOOTSTRAP" --list

echo ""
echo "===================================================================="
echo " FinWatch CDC topics — detail"
echo "===================================================================="
for topic in finwatch.public.accounts finwatch.public.merchants finwatch.public.transactions; do
  echo ""
  echo "--- $topic ---"
  docker exec "$KAFKA_CONTAINER" kafka-topics \
    --bootstrap-server "$BOOTSTRAP" \
    --describe --topic "$topic" 2>/dev/null || echo "  (not yet created)"
done

echo ""
echo "===================================================================="
echo " Consumer groups"
echo "===================================================================="
docker exec "$KAFKA_CONTAINER" kafka-consumer-groups \
  --bootstrap-server "$BOOTSTRAP" --list

echo ""
echo "===================================================================="
echo " Lag for ClickHouse consumer groups"
echo "===================================================================="
for group in clickhouse_transactions clickhouse_accounts clickhouse_merchants; do
  echo ""
  echo "--- $group ---"
  docker exec "$KAFKA_CONTAINER" kafka-consumer-groups \
    --bootstrap-server "$BOOTSTRAP" \
    --describe --group "$group" 2>/dev/null || echo "  (group not yet active)"
done
