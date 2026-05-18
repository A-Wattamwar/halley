from api import call_model_chat_completions
from answer_parser import extract_answer


def iterative_refinement(problem, q_type="general", max_iter=2):
    system = "Give only the final answer. No explanation."
    if q_type == "coding":
        system = "Write only the function body code."

    result = call_model_chat_completions(problem, system=system, temperature=0.0)
    if not result["ok"]:
        return {"answer": "", "confidence": 0.0}

    answer = extract_answer(result["text"], q_type)

    if q_type == "coding":
        return {"answer": answer, "confidence": 0.7}

    for _ in range(max_iter - 1):
        critique = call_model_chat_completions(
            f"Is this complete and correct? {answer[:300]}",
            temperature=0.3,
        )
        if not critique["ok"]:
            break

        if "correct" in critique["text"].lower() or "complete" in critique["text"].lower():
            return {"answer": answer, "confidence": 0.9}

        refined = call_model_chat_completions(
            f"{problem}\n\nImprove this answer: {answer[:200]}",
            system=system,
            temperature=0.0,
        )
        if refined["ok"]:
            answer = extract_answer(refined["text"], q_type)

    return {"answer": answer, "confidence": 0.7}
