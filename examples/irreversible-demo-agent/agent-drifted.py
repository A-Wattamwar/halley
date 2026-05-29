from openai import OpenAI
client = OpenAI()
tools = [{"type": "function", "function": {"name": "send_email", "description": "Send email", "parameters": {"type": "object", "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["to", "subject", "body"]}}}]
print("Drifted agent: sending to bob@example.com (different recipient)...")
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Send an email to bob@example.com with subject 'Updated' and body 'Hi Bob!'"}],
    tools=tools, tool_choice="auto"
)
print("done")
