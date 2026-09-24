# ADR-021: Team collaboration styles

## Status

Accepted. Extends ADR-016 and ADR-019.

## Decision

Team work requests support `solo`, `build_review` (default), `pipeline`, and
`lead_led`. `resolve_collaboration_style` in `collaboration/styles.py` resolves
explicit message style, task override, team setting, then the default. Task
dispatch supplies the task; thread messages resolve from message and team.
New team threads accept a first-message override through `/agent-runs`.

Role-based slot filling chooses one builder and a distinct reviewer for
Build → Review. Membership roles override agent defaults. A team without a
second eligible member runs Solo and records `styleFallbackFrom`. The lead
remains eligible; on-request specialists are not automatically enlisted.

The assignments' team snapshot freezes the style before dispatch. Manifests,
retries, lead plans, and historical UI labels use that frozen value. Legacy
manifests without a style ran Lead-led. Policies are `solo-v1`,
`build-review-v1`, `pipeline-v1`, and the existing Lead-led policies.

Only Lead-led marks a coordinator. Other styles use the existing evidence
gates and findings-to-owner repair path, with at most two repair cycles.
Runtime failures in those styles fail the round without coordinator recovery.
The reviewer runs in review mode. Required work applies to the compiled slots;
unselected roster members do not prevent completion.

Discussion, addressed-member messages, and recovery retain existing behavior.
The backend never executes agents; no daemon protocol or SQL migration changes.

## UI and rollout

One shared selector serves team settings, task/routine forms, and the composer.
Team settings preview role-based slots. Task overrides can return to team
inheritance. Composer overrides reset after successful send and survive failed
dispatch. Retry keys distinguish styles while preserving legacy unstyled keys.
Turn labels use each run's frozen style; review progress and solo fallbacks
are shown when applicable. Copy is available in English and both Chinese locales.

Existing teams without a stored style use Build → Review for future work.
Running rounds retain their captured style; teams can select Lead-led to keep
the old planning workflow.
