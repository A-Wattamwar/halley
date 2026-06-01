# Halley — Real-World Scenario

Version: 0.1 (May 13, 2026)
Owner: Ayush Wattamwar

This document exists to make Halley's value concrete. Instead of listing features, it tells one story two ways: without Halley, and with Halley. Read this first if ARCHITECTURE.md feels abstract.

---

## Meet the team

**Lumen Support** is a six-person startup. They sell a customer-support agent that companies drop into their Zendesk and Intercom instances. The agent triages tickets, drafts replies, issues refunds under a $50 limit, and escalates anything risky to a human.

Tech:
- Node.js service running the agent loop.
- OpenAI + Claude, chosen per task by a small router prompt.
- 8 tools the agent can call: `lookup_order`, `issue_refund`, `check_inventory`, `escalate_to_human`, and a handful more.
- Production: ~4,000 real conversations a day. About 1% go sideways in a way a customer notices.

Priya is the lead engineer. She is the only person who understands the full agent.

---

## Friday, 4:47 PM

Priya is finishing the week. A customer complained that the agent sounds robotic. She opens the system prompt, edits two lines, adds one sentence:

> "Keep responses concise. Avoid filler language."

She runs her three hand-picked test cases locally. They all pass. She merges, deploys, goes home.

This is the change:

```diff
- You are a helpful customer support agent. Provide accurate,
- thorough answers that address all parts of the customer's question.
+ You are a helpful customer support agent. Provide accurate answers.
+ Keep responses concise. Avoid filler language.
```

Harmless, right?

---

## Monday, 9:12 AM

Slack pings start. Three enterprise customers are complaining. Two common threads:

1. "The agent stopped issuing refunds. It just says it cannot help."
2. "The escalation message is completely empty now. Our humans are getting blank tickets."

Priya pulls up their observability dashboard. She has Langfuse self-hosted. She can see the traces. She can read every prompt and every response. She can even tell you that the `issue_refund` tool is being called less often since Friday.

What she cannot do:

- **Reproduce the exact broken run.** The offending conversations live in Langfuse, but Claude shipped a minor model update over the weekend, and the new model does not produce the same output for the same input. When she "reruns" a captured conversation, it works fine. She cannot make it fail on command.
- **Tell whether it is the prompt or the model.** Two things changed since Friday: her prompt edit, and Anthropic's model. She has no way to isolate.
- **Know how many customer workflows are affected.** She can see that refunds are down. She cannot tell whether the escalation-is-empty bug is the same root cause or a second thing. She does not know which other workflows have quietly degraded.
- **Prove a fix.** When she thinks she has patched it, she tests three prompts by hand. They look fine. She ships. She hopes. The customer complaints mostly stop. She will never be sure if her fix was complete or if Anthropic quietly reverted something.

She spends **six hours** on this between Monday and Tuesday. She does not work on the roadmap. The team's velocity for the week is shot. One customer does not renew.

This is not a rare story. [tianpan.co, April 2026](https://tianpan.co/blog/2026-04-15-debugging-llm-failures-field-guide) documents a fintech team losing $8,500 from a single-comma prompt change that degraded output. [Langchain's own writeup](https://www.langchain.com/articles/llm-evals) names the exact gap: most teams have no loop from production failures to reproducible regression tests.

Content paraphrased for licensing compliance.

---

## What was actually wrong

Let's be specific, because the specificity is the point.

- The word "concise" collapsed the structured output of the `issue_refund` tool. The agent's output used to include a detailed `reason` field. Now that field was one word. The Node code downstream parsed the response with a Zod schema that required `reason.length >= 10`. It threw. The agent caught the error and responded "I cannot help with that right now."
- The new prompt reduced the `escalate_to_human` body text to an empty string in about 30% of escalations, because the new prompt deprioritized generating an explanation when a tool call was being made.

Two different failure modes. One prompt change. Nothing in Priya's three local tests hit either path.

Both were silent. No exception in the logs. No alert fired. Just customer workflows that used to work now not working.

---

## The same Friday, with Halley

Rewind. Priya is making the same prompt change on Friday afternoon.

She has had Halley running for two months. Over those months, the dashboard has accumulated a few thousand real production runs. Whenever a customer support ticket came in that looked representative ("refund over $30," "escalation to tier-2," "customer asked in Spanish"), Priya clicked **Turn this run into a test** in the Halley dashboard. Halley walked her through the proposed invariants:

For the representative refund run:

- **Structural**: `lookup_order` is called exactly once, `issue_refund` is called exactly once, `escalate_to_human` is not called.
- **Schema**: the `issue_refund` tool input must match `{ order_id: string, amount: number, reason: string }`, and `reason.length >= 10`.
- **Metric**: total cost under $0.04, latency under 8 seconds.
- **Semantic** (off by default): left off because structural and schema already capture it.

She accepted those. Halley wrote the fixture to her repo as `halley/fixtures/refund-under-$30-happy-path.json` with the cassette bodies under `halley/fixtures/refund-under-$30-happy-path/bodies/`. She reviewed the PR like any other code change, merged it, moved on.

Over two months she built up about 400 fixtures. Not every run became one. Just the representative ones, or the hard ones a customer reported. This is like a test suite that writes itself from real traffic.

Now, Friday afternoon, she makes the prompt change and runs her usual tests. They pass. She pushes a PR.

GitHub Actions runs `halley ci` on the PR. It replays all 400 fixtures:

```
Replaying 400 fixtures against PR #1247...
  ✓ 374 passed (pure replay, 0 LLM calls, $0.00)
  ✗  26 failed (hybrid replay, 52 LLM calls made, $0.08)

Failures:
  refund-under-$30-happy-path.json
    ✗ schema:issue_refund.reason.length expected >=10, got 3 ("$30")
  
  escalation-to-tier-2.json
    ✗ schema:escalate_to_human.body expected non-empty string, got ""

  escalation-customer-abusive.json
    ✗ schema:escalate_to_human.body expected non-empty string, got ""

  ... 23 more, all of one of the two patterns above

Total time: 38 seconds.
```

The PR check is red. Priya sees, before merging, that 26 real customer scenarios would break. She can read the full diff for each failure: the exact input, the exact output, the invariant that broke, and the prompt diff that caused it.

She reverts the "Avoid filler language" sentence, re-runs, all 400 pass in 11 seconds, and ships the safer version of her change.

The weekend is not ruined. Monday is a normal Monday.

---

## What Halley did that Langfuse, Laminar, and LangSmith do not

- **Recorded every production run with bit-fidelity cassettes.** Not a summary. The exact LLM input and output bytes. This is what makes replay deterministic.
- **Let Priya promote a run into a permanent test with one click,** and suggested invariants she could accept, tighten, or reject. No writing eval scripts. No curating JSON datasets by hand.
- **Stored fixtures as portable files in her repo.** Versioned with code. Reviewable in PRs. Runnable offline. Halley could go away tomorrow and her fixtures would still work.
- **Replayed at zero LLM cost** when prompts had not changed (374 of 400 above). Ran in hybrid mode on the drifted calls (26 of 400), reporting exact cost incurred.
- **Named the failing invariant** precisely: not "this test failed," but "the `reason` field length dropped below 10 because of your prompt change."

Had she merged anyway, Halley would also have provided `halley bisect` on the next release to pinpoint which commit introduced a regression if one of her 400 fixtures ever fails in the future.

---

## Other scenarios Halley catches

The Friday-prompt-change story is the headline. The same loop catches:

### Model upgrades

Anthropic rolls Claude from 4.6 to 4.7. Priya's agent uses `claude-sonnet-4-latest`. Without Halley, she has no structured way to know whether anything in her 4,000-conversations-a-day product got worse. With Halley, she bumps the model in a PR, CI replays 400 fixtures in hybrid mode (all LLM calls go live because the model changed), and reports pass/fail per scenario plus total cost of the replay. If four fixtures fail, she has a concrete list of customer workflows to check before rolling out.

### Framework upgrades

She upgrades `@langchain/core` from 0.3 to 0.4. A small change to how tool outputs are serialized breaks her schema invariants on three fixtures. CI catches it. Without Halley, she would have merged, and production error rates on those three flows would have climbed silently over the next week.

### Tool-implementation refactors

She rewrites the `lookup_order` tool to hit a new database. Halley's replay runs in hybrid mode on that tool only: recorded LLM responses are served, but the tool is called fresh against the new backend. If the tool's output shape changes, downstream LLM calls will produce different outputs and invariants fire. The refactor lands with known blast radius, not hope.

### Compliance and audits

A regulator asks: "On March 14th at 14:23 UTC, your agent declined a refund for a customer in California. Reproduce that decision." Without Halley, she cannot. The model has moved. The conversation is gone. With Halley, the cassette for that run is in her repo. `halley record <run_id>` turns it into a fixture. She runs it and shows the regulator the exact same declined refund. [arXiv 2601.15322, January 2026](https://arxiv.org/html/2601.15322v1) documents that regulated industries currently fail this test routinely.

### Cost spikes

Anthropic changes their pricing. Priya's daily cost dashboard now reads differently. Halley's `pricing_version_id`-per-row design lets her ask, retroactively: "What would last month's traffic have cost under the new pricing?" Or, more usefully: "What would last month's traffic have cost if I had routed all of it to a different model?" The cost is read-time, not baked into historical rows.

---

## The loop, in one picture

```
                   Production traffic
                          │
                          ▼
                  Halley records
                 bit-fidelity cassettes
                          │
                          ▼
           User clicks "Turn into test"
                          │
                          ▼
          Halley proposes invariants,
            user accepts / tightens
                          │
                          ▼
       Fixture written to halley/fixtures/
               in the user's repo
                          │
                          ▼
      Future PR (prompt, model, framework,
              tool, or library change)
                          │
                          ▼
               halley ci replays
           (pure mode: $0; hybrid: bounded)
                          │
                          ▼
          Invariant fails → PR blocked
          halley bisect → names the commit
                          │
                          ▼
              Fix merged with proof
                          │
                          └──── production stays healthy
```

---

## What Halley does not do

- It does not write the fix. Halley tells you what broke and where. The engineer fixes it.
- It does not prevent all regressions. A failure mode that no historical run exercises cannot be caught by replaying historical runs. Halley only catches regressions on the scenarios you have fixtures for. The coverage grows the more you use the product.
- It does not replace a sanity LLM-as-judge on unfamiliar territory. Halley's default invariants are structural and schema-based because those are deterministic. Semantic judges are available but opt-in.

---

## Who Halley is for

Any team shipping LLM agents to production that has hit at least one of these:

- A prompt change broke something a customer noticed.
- A provider's model update degraded behavior silently.
- A framework upgrade caused a mysterious regression.
- A dev or CI LLM bill that feels out of proportion.
- A customer or regulator asked for a reproducible agent decision and could not get one.

If one of those is real for you, you are the user Halley is built for.

---

## TL;DR

Your production traffic is the best test suite you will ever have. You just cannot use it today, because LLMs are non-deterministic, models keep shifting, and you cannot afford to replay your CI against live APIs.

Halley makes that test suite usable. It records production runs with cassette fidelity, turns any run into a permanent regression test with one click, replays the whole library in CI for pennies or free, and tells you which real customer scenario just broke when you change something.

That is the loop. That is the one hero thing.

---

## Next

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the system is built to make this loop work.
- [`running-the-loop.md`](running-the-loop.md) — run the loop yourself: dashboard, runner, and terminal.
- [`fixture-format.md`](fixture-format.md) — what a fixture actually is on disk.
