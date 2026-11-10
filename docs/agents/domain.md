# Domain docs

Relay uses a single-context layout across its backend, daemon,
shared protocol, supervisor, and web packages.

## Before exploring

Read root `CONTEXT.md` for domain vocabulary and the ADRs in
`docs/adr/` relevant to the area being changed.

If a referenced document is absent, continue without creating it
solely for setup.

## Consumer rules

Use the terms defined in `CONTEXT.md`, including in issue titles,
code, tests, and documentation. Respect its listed avoided synonyms.

Update `CONTEXT.md` in the same change when the domain model changes.
Record durable architectural decisions in `docs/adr/`.

Explicitly identify any proposed change that contradicts an existing
ADR, citing the decision and explaining why it should be reconsidered.
