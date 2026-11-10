# Security

## Report a problem

Please do not open a public issue for a security bug.

Use GitHub's private report instead: open the repository's **Security** tab and choose **Report a vulnerability**. You will get an answer within 7 days.

## Supported versions

| Version | Gets security fixes |
|---|---|
| 0.x (latest) | Yes |
| Older 0.x | No. Upgrade to the latest |

## What agent-gate protects

| Threat | How it is stopped | Test |
|---|---|---|
| The model runs a write action on its own | Write tools never run in `handle`. They only return a pending action | `returns a pending action for a write tool and does not run it` |
| Someone changes the arguments between proposal and confirm | The arguments are inside an HS256 signature. A changed token is rejected | `rejects a token whose input was changed` |
| A token made with `alg: none` | Only HS256 is accepted | `rejects an unsigned token` |
| Another user confirms someone else's action | The token is bound to `actorId` | `rejects another actor and keeps the token usable for its owner` |
| The same confirm runs twice, at once or later | The token id is claimed once in the replay store before the tool runs | `lets only one of two concurrent confirms run` |
| The user lost access after the proposal | `authorize` runs again at confirm time | `checks permission again at confirm time` |
| An old token is used | Tokens expire after `ttlSeconds` (300 by default) | `rejects an expired token` |
| A client sends a number, an object or a huge string as the token | Anything that is not a string up to 64 KB is rejected before any verification | `rejects bad token shapes and sizes before any verification runs` |
| A caller forgets the user | `handle`, `confirm` and `cancel` throw when `ctx.actorId` is empty | `throws on a missing actor, because that is a bug in the caller` |
| A JWT signed elsewhere with the same secret | The signing key is derived from the secret for this one purpose | `rejects a JWT signed with the raw secret` |

## What it does not protect

| Not covered | What to do |
|---|---|
| Two servers with the in-memory store | Use a shared replay store with a unique key. See the README |
| A user who belongs to several workspaces | Check the workspace in your `authorize` |
| Secrets inside tool arguments | The token is signed, not encrypted. Keep secrets out of arguments |
| A `run` that is not idempotent | Use `action.id` as the idempotency key for payments and other outside calls |
| A stolen session | agent-gate trusts the `actorId` you pass. Your auth must be right |
