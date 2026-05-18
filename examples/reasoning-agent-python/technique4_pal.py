import re
from api import call_model_chat_completions


def pal_solve(problem):
    system = """You are a helpful assistant. For math problems, write Python code to solve it.
Put the final answer in a variable called 'answer'.
Only output the Python code, nothing else. No markdown, no explanation."""

    result = call_model_chat_completions(problem, system=system, temperature=0.0)

    if not result["ok"] or not result["text"]:
        return {"answer": "", "confidence": 0.0}

    code = result["text"].strip()
    code = re.sub(r'^```python\s*', '', code)
    code = re.sub(r'^```\s*', '', code)
    code = re.sub(r'\s*```$', '', code)

    if len(code) > 500 or 'while ' in code or 'for ' in code:
        return {"answer": "", "confidence": 0.0}

    try:
        local_vars = {}
        exec(code, {"__builtins__": {}}, local_vars)
        answer = local_vars.get("answer", "")
        if answer != "":
            return {"answer": str(answer), "confidence": 0.95}
    except Exception:
        pass

    return {"answer": "", "confidence": 0.0}
