from api import call_model_chat_completions
from answer_parser import extract_answer


def cot_with_verification(problem, q_type="general"):
    system = "Think step by step, then give the final answer."
    if q_type == "coding":
        system = "Write only the function body code."

    result = call_model_chat_completions(problem, system=system, temperature=0.0)
    if not result["ok"]:
        return {"answer": "", "confidence": 0.0}

    answer = extract_answer(result["text"], q_type)

    if q_type == "coding":
        return {"answer": answer, "confidence": 0.7}

    verify = call_model_chat_completions(
        f"Is this answer correct? Answer YES or NO only.\nQuestion: {problem[:300]}\nAnswer: {answer[:200]}",
        system="Reply YES or NO only.",
        temperature=0.0,
    )

    if verify["ok"] and "yes" in verify["text"].lower():
        return {"answer": answer, "confidence": 0.9}

    return {"answer": answer, "confidence": 0.5}
