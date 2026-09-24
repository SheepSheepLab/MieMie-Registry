# Hub update relay (0.3.1)

`POST /api/hub/releases/asset` accepts exactly positive integer `releaseId` and
`assetId` fields. No login is required; the existing allowed-Origin policy,
per-IP limits, concurrent transfer limits and disconnect cancellation apply.

The repository is fixed to `SheepSheepLab/MieMie-Hub`. Only its verified
`MieMie-Hub-update.json` and corresponding `MieMie-Hub-<version>.json` are allowed.
The server checks the public repository, Release, metadata, product identity,
fixed script ID, raw digest/size, single-script structure and content hash, then
re-reads the Release lock after transfer. Redirects are limited to official GitHub
HTTPS hosts. Downloaded code is never executed or persistently hosted.

The existing Extension relay keeps its independent Manifest validation and does
not accept Hub packages. Clients cannot choose the validation mode or arbitrary
URLs. OAuth, Owner, database configuration and schema remain unchanged (Schema 3).

Deploy through a versioned release directory after a consistent verified backup.
Update the operational health helper's expected version to 0.3.1, leaving Schema 3.
A GitHub release alone does not activate the endpoint on the production server.
