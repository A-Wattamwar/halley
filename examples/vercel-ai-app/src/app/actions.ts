"use server";

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function askQuestion(question: string): Promise<string> {
    const { text } = await generateText({
        model: openai("gpt-4o-mini"),
        prompt: question,
        // experimental_telemetry MUST be set per-call.
        // Without isEnabled: true, no spans are emitted.
        experimental_telemetry: {
            isEnabled: true,
            functionId: "ask-question",
            metadata: {
                source: "halley-vercel-ai-example",
            },
        },
    });

    return text;
}
