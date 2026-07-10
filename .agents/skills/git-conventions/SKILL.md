---
name: git-conventions
description: Commit message and branch naming conventions for this repo. Use whenever creating a commit or a branch.
---

# Git conventions

## Commit messages

Every commit message follows:

```
${type}: ${description}
```

- `type` is exactly one of: `feat`, `chore`, `fix`
- `description` is a short, imperative, lowercase summary (e.g. "add xrpl address derivation", not "Added XRPL address derivation.")
- No scopes, no other types (`docs`, `refactor`, etc. are not used — pick the closest of the three)

Examples:

```
feat: add zone recovery blob unwrap
fix: reject reused session-auth nonces
chore: bump typescript to 6.0.2
```

## Branches

Branch names follow:

```
${type}/${description}
```

- Same three types: `feat`, `chore`, `fix`
- `description` is kebab-case (e.g. `feat/stellar-connector`, `fix/nonce-replay`)

## Type selection

- `feat` — new user-facing or API-facing capability
- `fix` — corrects broken behavior
- `chore` — everything else: tooling, deps, config, docs, refactors, tests
