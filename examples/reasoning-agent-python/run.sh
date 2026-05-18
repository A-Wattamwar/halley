#!/usr/bin/env bash
# run.sh — set up venv, install deps, run the agent on a sample question.
# Usage:
#   ./run.sh                          # runs the default sample question
#   ./run.sh "What is 47 * 23 + 19?"  # runs a custom question
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Create venv if it doesn't exist
if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

# Activate venv
# shellcheck disable=SC1091
source .venv/bin/activate

# Install / upgrade deps
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# Default question
QUESTION="${1:-Solve: 47 * 23 + 19}"

echo ""
echo "Running Reasoning Agent..."
echo "Question: $QUESTION"
echo "Model:    ${MODEL_NAME:-gpt-4o-mini}"
echo "OTLP:     ${TRACELOOP_BASE_URL:-http://localhost:4318}"
echo ""

python agent.py "$QUESTION"

echo ""
echo "Done. Verify traces in ClickHouse:"
echo "  docker exec halley-clickhouse clickhouse-client \\"
echo "    --query \"SELECT count(), gen_ai_request_model, gen_ai_usage_input_tokens \\"
echo "             FROM halley.observations \\"
echo "             WHERE source_dialect = 'openllmetry' \\"
echo "             GROUP BY gen_ai_request_model, gen_ai_usage_input_tokens \\"
echo "             ORDER BY count() DESC LIMIT 10\""
