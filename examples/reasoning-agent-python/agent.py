"""
agent.py — Main orchestrator for the Reasoning Agent.

Unchanged from the original except for the OpenLLMetry instrumentation block
at the top. Traceloop auto-instruments the openai package, so every
call_model_chat_completions() call in the four technique files produces a span
automatically. No changes to solve() or any technique file are needed.

OpenLLMetry setup:
  Set TRACELOOP_BASE_URL=http://localhost:4318 in your environment.
  The SDK appends /v1/traces automatically.
  disable_batch=True ensures spans flush before the process exits.
"""

import os
from traceloop.sdk import Traceloop

Traceloop.init(
    app_name="reasoning-agent",
    disable_batch=True,  # short-lived script: flush synchronously on exit
)

from answer_parser import classify_question, normalize_answer
from technique1_self_consistency import self_consistency
from technique2_cot_verify import cot_with_verification
from technique3_refinement import iterative_refinement
from technique4_pal import pal_solve


def solve(problem):
    q_type = classify_question(problem)
    results = []

    if q_type == "math":
        r0 = pal_solve(problem)
        if r0["answer"]:
            results.append(r0)
        r1 = self_consistency(problem, q_type)
        if r1["answer"]:
            results.append(r1)

    elif q_type == "general":
        r1 = self_consistency(problem, q_type)
        if r1["answer"]:
            results.append(r1)
        r2 = cot_with_verification(problem, q_type)
        if r2["answer"]:
            results.append(r2)

    else:
        r1 = self_consistency(problem, q_type)
        if r1["answer"]:
            results.append(r1)
        r2 = cot_with_verification(problem, q_type)
        if r2["answer"]:
            results.append(r2)

    if not results:
        return ""

    if q_type in ["coding", "planning"]:
        best_result = max(results, key=lambda x: x["confidence"])
        return best_result["answer"]

    weights = {}
    for r in results:
        ans = normalize_answer(r["answer"]) if q_type != "future" else r["answer"]
        conf = r["confidence"]
        weights[ans] = weights.get(ans, 0) + conf

    return max(weights, key=weights.get)


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python agent.py \"Your question here\"")
        sys.exit(1)

    question = " ".join(sys.argv[1:])
    print(f"Question: {question}")
    answer = solve(question)
    print(f"Answer:   {answer}")
