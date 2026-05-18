"""
api.py — OpenAI SDK adapter for the Reasoning Agent.

This file replaces the original ASU-VPN-specific HTTP wrapper with a direct
OpenAI SDK call. The function signature and return shape are identical to the
original so all four technique files work unchanged.

Original used: requests.post to http://10.4.58.53:41701/v1 (ASU network only)
This version uses: openai.OpenAI() pointing at api.openai.com

Environment variables:
  OPENAI_API_KEY   — required, your OpenAI API key
  MODEL_NAME       — optional, defaults to "gpt-4o-mini" (D-43: mini only)
"""

import os
from openai import OpenAI

MODEL = os.getenv("MODEL_NAME", "gpt-4o-mini")

_client = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


def call_model_chat_completions(
    prompt: str,
    system: str = "You are a helpful assistant. Reply with only the final answer. no explanation needed.",
    model: str = MODEL,
    temperature: float = 0.0,
    timeout: int = 60,
) -> dict:
    """
    Call the OpenAI chat completions API.

    Returns a dict matching the original api.py contract:
      {"ok": bool, "text": str | None, "raw": dict | None,
       "status": int, "error": str | None, "headers": dict}
    """
    try:
        client = _get_client()
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=temperature,
            max_tokens=1024,
            timeout=timeout,
        )
        text = response.choices[0].message.content or ""
        return {
            "ok": True,
            "text": text,
            "raw": response.model_dump(),
            "status": 200,
            "error": None,
            "headers": {},
        }
    except Exception as e:
        return {
            "ok": False,
            "text": None,
            "raw": None,
            "status": -1,
            "error": str(e),
            "headers": {},
        }
