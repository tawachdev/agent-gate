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
| A token made in one workspace is confirmed in another by the same user | The token carries `ctx.scope` and confirm requires the same scope | `binds the token to the workspace it was made in` |
| The user approved one thing and something else runs | The summary from `describe` is signed. Confirm runs `describe` again and refuses a different summary | `refuses to run when the summary the user approved no longer matches` |
| A read tool with no permission check | `authorize` is required on every tool, by type | `checks permission on read tools too` and the type test in `providers.test-d.ts` |
| Two servers accept the same token | `postgresReplayStore` claims the token id with a primary key | `runs the action exactly once when 20 confirms race across both servers` |
| A correctly signed token with missing or wrong claims | Every claim is parsed with a schema after the signature check | `rejects a correctly signed token that is missing the approved summary` |
| A JWT signed elsewhere with the same secret | The signing key is derived from the secret with HKDF-SHA-256 for this one purpose | `rejects a JWT signed with the raw secret, so other uses of the secret cannot mint actions` |
| Another kind of JWT from the same system is replayed here | The header must say `typ: agent-gate+jwt` | `rejects a correctly signed token of another JWT type` |
| A leaked secret must be replaced without downtime | List the new secret first and the old one second, then drop the old one after `ttlSeconds` | `rejects the old secret once it is removed` |

## What it does not protect

| Not covered | What to do |
|---|---|
| You forget to pass `ctx.scope` | Scope binding only works when you pass it on both `handle` and `confirm` |
| A record from another workspace inside the arguments | Your `authorize` must check who owns the record |
| A tool marked `read` that changes data | agent-gate trusts the `kind` you give. Review every `read` tool |
| Secrets inside tool arguments | The token is signed, not encrypted. Keep secrets out of arguments |
| A `run` that is not idempotent | Use `action.id` as the idempotency key for payments and other outside calls |
| A stolen session | agent-gate trusts the `actorId` you pass. Your auth must be right |
