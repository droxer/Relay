# ADR-022: Agent-drafted project setup and a project brief every run reads

## Status

Accepted. Extends ADR-016 and ADR-017.

## Context

A project was set up as a record: the owner typed a name, picked a computer,
then hand-wrote a role and responsibilities for each agent. Agents never saw
what the project was for — the description stopped at the database, and each
run received only its own responsibilities line. Decisions made in one thread
were lost to the next unless someone copied them into every agent's
instructions.

## Decision

**The project brief reaches every run.** A project has a `goal` and a
markdown `context` beside its description. The round pins the project snapshot
it dispatched with; the backend renders name, goal, summary, enabled crew, and
context into the `[Project]` prompt section. The daemon mirrors the same text
to `.relay/PROJECT.md` for the run. A context edit bumps `contextRevision` and
reaches the next round, never half of a running one.

**Agents propose, owners apply.** Setup is an ordinary daemon run — the backend
still never executes agents. One agent on the project's computer, admitted by
the project-task rule rather than roster membership (there is no crew yet),
reads the owner's intent and the candidate agents and writes a proposal file.
The backend normalizes it to the PATCH's shape and stores it on the project.
Applying is the ordinary project PATCH carrying the accepted fields plus
`setupResolution`, so roster validation runs at the moment the change takes
effect. Revisions draft again in the same thread; a failed or stopped run marks
the setup failed instead of leaving it waiting.

**Runs suggest context; owners adopt it.** A project run may add up to three
`contextSuggestions` to its round result. They wait on the project, attributed
to their run, until the owner adopts (in the same save that edits the context)
or dismisses them. Nothing an agent writes changes the standing brief by itself.

## Consequences

- Creating a project can start from one sentence; the manual form remains.
- A daemon without `project-setup` refuses setup rounds instead of leaving
  proposals unread; the web falls back to manual setup.
- Setup and suggestion results arrive outside any editor's revision. They write
  against the current revision and bump it, so a stale editor save surfaces as
  the usual conflict rather than erasing them.
- Setup transitions check the draft identity and state inside the project
  mutation. Late results leave newer drafts and owner resolutions untouched;
  definitive failures before delivery close the draft too. Proposal files are
  named per run, and only setup commands consume them.
- A setup thread's later chat turns are not setup rounds; revising goes through
  `POST /projects/{id}/setup` with `revise: true`.
