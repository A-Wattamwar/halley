"""
Minimal demo agent that uses function tool calling.
send_email is marked irreversible in halley.config.json.

This exists only to demonstrate the irreversible tool guard:
- In RECORD mode: calls the real API, records the response.
- In hybrid REPLAY mode with a miss: the guard intercepts send_email
  before a live call reaches the provider.
"""

import os
import json
from openai import OpenAI

client = OpenAI()  # reads OPENAI_API_KEY from env

tools = [
    {
        "type": "function",
        "function": {
            "name": "send_email",
            "description": "Send an email to a recipient",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
]

print("Demo agent: asking model to send an email...")
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "user", "content": "Send an email to alice@example.com with subject 'Hello' and body 'Hi Alice!'"}
    ],
    tools=tools,
    tool_choice="auto",
)
print(f"Response: {response.choices[0].message.content or '(tool call)'}")
if response.choices[0].message.tool_calls:
    tc = response.choices[0].message.tool_calls[0]
    print(f"Tool call: {tc.function.name}({tc.function.arguments})")
