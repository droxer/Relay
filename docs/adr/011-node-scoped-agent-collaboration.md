# ADR-011: Keep Agent Collaboration Node-Scoped

## Status

Accepted, as refined by [ADR-013](013-thread-scoped-workspaces.md). Thread
runtime affinity remains node-scoped; writable working directories are now
thread-scoped beneath that node's configured workspace root.

Relay permits a user's independent agents to be placed on different
computers, but a collaborative team and every multi-agent session must resolve
all participating agents to one daemon node. A matching canonical workspace ID
or `shared-path` policy does not authorize cross-node collaboration: those
signals cannot prove identical filesystem state, isolation, latency, or failure
semantics. This trades cross-node scheduling flexibility for a clear workspace
and trust boundary that the backend can enforce at team assembly, routing, and
final daemon dispatch.

A new thread therefore selects one computer as its **thread runtime** before
its first agent run. Relay persists that node identity on the session and uses
it as immutable routing affinity for every later run and handoff. The composer
only offers active agents placed on the selected computer.

## Consequences

- Agents without an active placement cannot join a team.
- Team members on different nodes must be moved to one node before assembly.
- Existing teams that later lose co-location cannot execute until their
  placements are repaired.
- A thread cannot move to another computer after it starts; users start a new
  thread when they need another runtime.
- New-thread clients must choose an available computer before dispatch and
  scope their agent picker to active placements on that computer.
- Workspace identity remains available for continuity and drift detection, not
  as a substitute for node identity.
- Any future cross-node cooperation must use an explicit artifact or messaging
  protocol and will not silently reuse node-scoped team semantics.
