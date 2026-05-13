#!/bin/bash
# Create the halley database if it does not already exist.
# This script runs inside the ClickHouse container at first boot via
# /docker-entrypoint-initdb.d/. It is idempotent: IF NOT EXISTS means
# a second run (e.g. after a container restart without volume removal)
# is a no-op.
#
# Note: the official ClickHouse image also creates the database named
# in CLICKHOUSE_DB automatically, so this script is belt-and-suspenders.
# It ensures the database exists before the numbered .sql migrations run,
# regardless of image version behaviour.
set -euo pipefail

clickhouse-client \
  --host localhost \
  --query 'CREATE DATABASE IF NOT EXISTS halley'

echo "000_create_database.sh: halley database ready"
