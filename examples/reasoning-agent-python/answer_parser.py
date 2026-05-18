import re
from api import call_model_chat_completions


def classify_question(question):
    system = "You are a question classifier. Reply with exactly one word."
    prompt = f"""Classify this question into ONE category:
- math: calculations, numbers, arithmetic, algebra, geometry
- coding: write code, function, program, algorithm
- planning: sequence of actions, steps, moves, logistics
- future: predictions, forecasts, future events
- general: factual questions, reading comprehension, common sense, multiple choice

Question: {question[:500]}

Reply with exactly one word: math, coding, planning, future, or general"""
    result = call_model_chat_completions(prompt, system=system, temperature=0.0)

    if result["ok"]:
        text = result["text"].strip().lower()
        for cat in ["math", "coding", "planning", "future", "general"]:
            if cat in text:
                return cat
    return "general"


def extract_answer(text, question_type="general"):
    if not text:
        return ""
    text = text.strip()

    if question_type == "coding":
        return extract_coding(text)

    if question_type == "future":
        return extract_future(text)

    if question_type == "planning":
        return extract_planning(text)

    boxed = re.search(r"\\boxed\{([^}]+)\}", text)
    if boxed:
        return boxed.group(1).strip()

    for pattern in [r"[Ff]inal [Aa]nswer[:\s]+([^\n]+)", r"[Tt]he answer is[:\s]+([^\n]+)"]:
        match = re.search(pattern, text)
        if match:
            return match.group(1).strip()

    if question_type == "math":
        nums = re.findall(r'-?\d+\.?\d*', text)
        if nums:
            return nums[-1]

    if len(text) < 200:
        return text

    return text.split('\n')[0][:200]


def extract_future(text):
    boxed = re.search(r'\\boxed\{([^}]+)\}', text)
    if boxed:
        val = boxed.group(1).strip()
        try:
            float(val)
            return f"[{val}]"
        except Exception:
            return f"['{val}']"

    list_match = re.search(r'\[.+?\]', text, re.DOTALL)
    if list_match:
        content = list_match.group(0)
        content = re.sub(r'\\boxed\{([^}]+)\}', r'\1', content)
        if content.startswith('[') and content.endswith(']'):
            return content

    text_lower = text.lower()
    if text_lower.startswith('yes') or 'yes' in text_lower[:20]:
        return "['Yes']"
    if text_lower.startswith('no') or 'no' in text_lower[:20]:
        return "['No']"

    items = re.split(r'[,、，]', text)
    if len(items) > 1:
        clean = [i.strip() for i in items if i.strip()]
        return "['" + "', '".join(clean[:5]) + "']"

    return f"['{text[:100]}']"


def extract_planning(text):
    actions = re.findall(r'\([a-z][\w-]*(?:\s+[\w-]+)*\)', text, re.IGNORECASE)
    if actions:
        valid = [a for a in actions if not any(word in a.lower() for word in ['step', 'analyze', 'let', 'problem'])]
        if valid:
            return '\n'.join(valid)

    text = re.sub(r'object[_\s]*', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+from\s+', ' ', text, flags=re.IGNORECASE)

    parts = re.split(r'[\n,;]+', text)
    formatted = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        words = re.findall(r'[a-z]\w*', part, re.IGNORECASE)
        if words:
            formatted.append('(' + ' '.join(words) + ')')

    if formatted:
        return '\n'.join(formatted)

    return text


def extract_coding(text):
    text = re.sub(r'^```python\s*\n?', '', text)
    text = re.sub(r'^```\s*\n?', '', text)
    text = re.sub(r'\n?```$', '', text)

    lines = text.strip().split('\n')
    body = []
    for line in lines:
        if line.strip().startswith('import ') or line.strip().startswith('from '):
            continue
        if line.strip().startswith('def '):
            continue
        body.append(line)
    return '\n'.join(body).strip()


def normalize_answer(answer):
    return str(answer).strip().lower()
