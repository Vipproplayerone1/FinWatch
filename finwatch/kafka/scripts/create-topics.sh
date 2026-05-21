#!/usr/bin/env bash
# ============================================================================
# create-topics.sh
# ----------------------------------------------------------------------------
# Pre-create FinWatch Kafka topics with explicit partition / retention config.
# Debezium will auto-create them on first publish if they don't already exist,
# but pre-creating gives you control over partitions and retention.
#
# Usage (from inside the finwatch/ project root):
#     bash kafka/scripts/create-topics.sh
#
# Requires the Kafka broker container `finwatch-kafka` to be up and healthy.
# ============================================================================

set -euo pipefail

KAFKA_CONTAINER="${KAFKA_CONTAINER:-finwatch-kafka}"
BOOTSTRAP="${BOOTSTRAP:-kafka:9092}"

# topic_name | partitions | retention_ms (7 days default)
TOPICS=(
  "finwatch.public.accounts|3|604800000"
  "finwatch.public.merchants|3|604800000"
  "finwatch.public.transactions|6|604800000"
  "_finwatch_connect_configs|1|-1"
  "_finwatch_connect_offsets|25|-1"
  "_finwatch_connect_status|5|-1"
)

echo "Creating Kafka topics on $BOOTSTRAP via $KAFKA_CONTAINER..."

for entry in "${TOPICS[@]}"; do
  IFS='|' read -r name parts retention <<< "$entry"

  echo "  -> $name (partitions=$parts, retention.ms=$retention)"
  docker exec "$KAFKA_CONTAINER" kafka-topics \
    --bootstrap-server "$BOOTSTRAP" \
    --create \
    --if-not-exists \
    --topic "$name" \
    --partitions "$parts" \
    --replication-factor 1 \
    --config "retention.ms=$retention" \
    --config "cleanup.policy=delete" \
    >/dev/null
done

echo ""
echo "Done. Current topics:"
docker exec "$KAFKA_CONTAINER" kafka-topics --bootstrap-server "$BOOTSTRAP" --list
