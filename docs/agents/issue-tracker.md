# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `droxer/Relay`.
Use the `gh` CLI with an explicit `--repo droxer/Relay`.

## Operations

- Read: `gh issue view <number> --repo droxer/Relay --json number,title,body,labels,comments`
- List: `gh issue list --repo droxer/Relay --state open --json number,title,labels`
- Create: `gh issue create --repo droxer/Relay --title "..." --body-file <path>`
- Comment: `gh issue comment <number> --repo droxer/Relay --body-file <path>`
- Label: `gh issue edit <number> --repo droxer/Relay --add-label "..."`
- Close: record the explanation, then run
  `gh issue close <number> --repo droxer/Relay`.

Prepare multiline issue bodies and comments in local files.
Follow AGENTS.md's External Action Boundaries before making remote changes.

When a skill says “fetch the relevant ticket,” read the GitHub issue.
When it says “publish to the issue tracker,” create a GitHub issue
after obtaining the required authorization.

## Pull requests as a triage surface

**PRs as a request surface: no.**
