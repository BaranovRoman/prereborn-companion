# Research workflow

This directory holds durable results of research/discovery/audit tasks — the kind of work
that answers "what should we do about X" rather than implementing something directly.

## Why this exists

Weeek (and the current `weeek-mcp` integration) has no good way to store a long research
write-up as a comment or attachment. If a research result only lives in an AI chat
transcript or a PR description, it is effectively lost once the chat/PR is closed or
forgotten. A file in this directory survives both.

## Rule

Any research/discovery/audit task must leave its result in `docs/research/<topic>.md`,
committed alongside (or as) the task's changes. Use a short, kebab-case topic name
(e.g. `backend-beta-capacity.md`, `obs-scene-mapping-limits.md`).

If the research leads to an implementation change in the same ticket, the artifact is
still created — it records the decision that was made and why, not just the option space.

A PR description may summarize the research, but it is not a substitute for the artifact.
PR descriptions are not reliably searchable or preserved the way repository files are.

## Structure

Use this structure. Keep sections short — this is a decision record, not a report.

```markdown
# Topic

## Question
What we're researching and what decision this needs to enable.

## Current state
What already exists in the project relevant to this question.

## Findings
Confirmed facts. Distinguish these clearly from assumptions/guesses (see below).

## Options
The real options considered, with trade-offs.

## Recommendation
The recommended option and why.

## Follow-up
Whether an implementation task is needed, and roughly what it would involve.

## Sources
Primary/official sources, if external information was used.
```

## Additional rules

- Separate measured/confirmed facts from assumptions. If something wasn't measured, say so
  explicitly instead of implying it was (e.g. "not measured" rather than a guessed number).
- Don't claim production capacity, performance, or scale numbers without a measurement.
  If you couldn't measure something (missing credentials, no access to prod-like
  environment, etc.), say what's missing rather than estimating silently.
- For external technologies/libraries, prefer official documentation over blog posts or
  secondary sources; link what you actually used in `## Sources`.
- Don't let this turn into a wiki. One file per topic, no cross-linking hub pages, no
  "living document" that keeps growing after the decision is made — if the topic resurfaces
  materially, write a new dated file or a clearly separated follow-up section.
- Write enough that the decision can be reconstructed months later without the original
  AI chat or PR discussion — but no more than that.
