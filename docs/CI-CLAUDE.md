# Headless Claude Code in CI

Two workflows sit beside the existing `ci.yml`, which is unchanged.

| Workflow | Runs when | What it does | Can it fail a PR? |
| --- | --- | --- | --- |
| `.github/workflows/claude-review.yml` | A pull request from a branch in this repo is opened, pushed to, reopened or marked ready | Claude Code runs headless on the diff and the workflow posts one comment, updated in place on later pushes | No. Advisory only |
| `.github/workflows/nightly.yml` | 08:23 UTC daily; manually from the Actions tab; once on any PR that edits the file | `npm test` under `TZ=UTC` and `TZ=Pacific/Kiritimati`, then `npm run eval:dry` (the MCP eval with its scripted model) | Yes. Any failing test or eval scenario fails the run |

The nightly calls no model and uses no secret. The paid eval (`npm run eval`, real Claude calls) stays manual, as `apps/mcp/eval/run.ts` says.

## The review's permission set

- **Trigger:** `pull_request` only, never `pull_request_target`.
- **Fork rule:** the job runs only when the PR's head repo is this repo and the PR is not a draft. Fork PRs are skipped before any step runs, so fork code never meets the token. GitHub withholds secrets from fork-triggered runs as well.
- **Two jobs, two privileges:**
  - `review` holds `CLAUDE_CODE_OAUTH_TOKEN` (in one step only) with `contents: read` and `pull-requests: read`.
  - `comment` holds `pull-requests: write`. It never sees the Claude token and never calls a model.
  - Only a capped, validated JSON summary passes from `review` to `comment`.
- **Claude's tools:** `Read`, `Grep` and `Glob`, run with `--safe-mode --restricted`. That means:
  - No shell, network, edit, write or MCP tools.
  - File access is held to the checked-out PR files.
  - Nothing from the PR's own `CLAUDE.md`, `.claude/`, `.mcp.json` or hooks is loaded.
  - `--permission-mode dontAsk --permission-prompts none` denies anything else.
  - Read is denied for `.env*`, `*.pem`, `*.key` and `.git/`.
- **Untrusted input:** the PR's diff, files, comments and commit text may carry prompt injection. The system prompt (`.github/claude-review/system-prompt.md`) tells Claude to report any such instruction, not follow it. The tool set means it could not act on one anyway.
- **Nothing in the PR is executed:**
  - No install, build or test step runs. The checkout keeps no git credentials.
  - The comment is rendered by `jq` from schema-checked fields (`.github/claude-review/review.schema.json`).
  - HTML is escaped, `@mentions` are broken so they ping nobody, and each finding is capped at 600 characters, with at most 20 findings.
  - The raw model output is never printed, because logs on a public repo are public.
- **Pinned:**
  - Claude Code `2.1.292`, installed with the official installer, with auto-update off.
  - Model `claude-sonnet-5`.
  - Every third-party action by commit SHA.

## The budget

| Cap | Value |
| --- | --- |
| Turns | `--max-turns 12` |
| Estimated spend | `--max-budget-usd 0.50`. This is a client-side estimate; on a subscription nothing is billed per run |
| Time | 8-minute CLI timeout inside a 10-minute job |
| Diff size | Reviews skipped above 3,000 changed lines |
| Overlap | A new push cancels the review still running for the same PR |

The run summary in the Actions tab records turns, estimated cost and any denied tool call. A denied call raises a warning, because the prompt asks for nothing that needs one.

Runs draw on your Claude subscription's usage limits, the same pool as your interactive work. There is no separate CI cap.

## Turn it on

The review skips with a green check and a notice until the secret exists. Run these two commands on your own machine:

```bash
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R shanelabountyai/bookable-appointment-service
```

The first opens a browser and prints a one-year token tied to your subscription. The second prompts for the token, so paste it there. Nothing else is needed: the workflow calls the CLI directly, so the Claude GitHub App is not required. If the token leaks, run `claude setup-token` again and re-set the secret.

## Get an email when the nightly fails

GitHub's docs say notifications for a scheduled workflow go to the user who created the workflow, or the last user to change its `cron`. Whether that user is emailed depends on their own setting, and the docs give no default. To check yours:

1. Open https://github.com/settings/notifications.
2. Under **System → Actions**, choose **Email**.
3. Tick **Only notify for failed workflows**, then **Save**.

Scheduled workflows in a public repo stop after 60 days without repo activity. Re-enable one from the Actions tab.

## Turn it off

- **Pause:** Actions tab → the workflow → **⋯ → Disable workflow**. Or run `gh workflow disable claude-review.yml -R shanelabountyai/bookable-appointment-service`, and the same for `nightly.yml`.
- **Stop the review spending:** delete the secret with `gh secret delete CLAUDE_CODE_OAUTH_TOKEN -R shanelabountyai/bookable-appointment-service`. The review then skips cleanly. Deleting the secret does not revoke the token.
- **Remove:** delete the two workflow files and `.github/claude-review/`.

## Sources

- Claude Code GitHub Actions: https://code.claude.com/docs/en/github-actions
- Headless mode (`-p`, JSON output, `--json-schema`, `dontAsk`, `--permission-prompts none`): https://code.claude.com/docs/en/headless
- CLI reference (`--safe-mode`, `--restricted`, `--tools`, `--max-turns`, `--max-budget-usd`): https://code.claude.com/docs/en/cli-reference
- Authentication (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`): https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- Pinned install: https://code.claude.com/docs/en/setup#install-a-specific-version
- claude-code-action security notes: https://github.com/anthropics/claude-code-action/blob/main/docs/security.md
- GitHub secure use (`pull_request_target`): https://docs.github.com/en/actions/reference/security/secure-use
- GitHub workflow-run notifications: https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs and https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications
