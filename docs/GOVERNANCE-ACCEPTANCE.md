# Governance final acceptance — 0.3.2

## Blocking finding fixed

In 0.3.1, an author changing their own Official submission to Community implicitly set `moderation_protected=0`. This bypassed the Owner-only protection operation and let ordinary moderators subsequently hide the previously protected item. An isolated HTTP/SQLite regression reproduced the failure before the fix.

0.3.2 preserves the latest stored protection when returning to Community. Publishing Official still enables protection by default. Only the Owner protection endpoint can explicitly remove protection. Security Hold, owner/submitter identity and authored fields retain their existing contracts. Classification audit captures the governance state immediately before the transaction, including decisions made during asynchronous source validation.

No database migration: schema remains 3. No OAuth, domain, TLS, secret, Owner configuration, gateway policy or Hub/Polisher changes.

## Verified role boundaries

See [role matrix](GOVERNANCE.md). All authorization is server-side, refreshed from the session identity and current roles. Owner comes exclusively from the private exact Snowflake configuration, independently of the role database. Matching names cannot confer Owner or Official status.

The added final-acceptance suite tests protection downgrade, concurrent Owner decisions, renamed Owner and impersonated profile, normal/publisher direct API denial, identity spoofing, full role grant/revoke and audit, in-flight ban, and transactional rollback if audit recording fails. Existing tests cover Admin Community-only moderation, protected Official denial, content ownership, OAuth/state/replay/profile, guild ACL, ban/login/read behavior, 180-day retention and hold, schema migration, type/distribution and gateway validation.

Soft Unlist is retained for at least 180 days; cleanup is an explicit operational action, not a new scheduled deletion. Security Hold and hidden moderation prevent purge. Ban does not silently remove existing catalog entries; separate Hide remains available to Owner. Session logout and OAuth remain available to banned users.

## Gateway boundary

The extension relay accepts validated public GitHub repository and locked Release/Asset identifiers, never an arbitrary client download URL. It validates the MieMie package metadata, asset and content hashes and trusted GitHub redirect hosts. Hub repeats checks independently. Non-package EXE/DMG/APK downloads do not become managed installations.

The gateway intentionally does not require a live listed Catalog row: already installed extensions may continue updates after unlisting, and explicit repository preview/install remains supported. There is no permanent community file storage. Existing size/time/concurrency limits and short metadata caches remain unchanged.

## Acceptance evidence and gate

Local regression: Registry 141 tests, Hub 201 tests, explicit Hub/Registry HTTP contract 12 checks, Admin Console HTTP/DOM 7 checks, built Hub/Polisher integration 28 checks, ecosystem install/update/uninstall and launcher 13 checks. OAuth in automated tests uses a test adapter; these checks do not claim real Discord authorization.

The operator confirmed real production Discord login and Owner management visibility on 0.3.1. Public production health/catalog and existing Polisher are checked separately. The correction must be deployed and production health/integrity/Owner/catalog reverified before Phase A can pass. Phase B Timeline/Core changes must not begin before that gate. Real second-account role testing is a non-blocking follow-up; destructive role/ban/retention checks run only in isolated fixtures.

Deploy in order: stage and test the verified release archive; create and verify a fresh schema-3 backup; atomically switch code and the operational health version; verify health, integrity, Owner authorization and preserved foundation configuration. Do not restore old schema-2 snapshots into this release or rerun Owner bootstrap. Keep prior releases and recovery materials.
