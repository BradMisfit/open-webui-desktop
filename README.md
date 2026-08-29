# Open WebUI Desktop — custom release feed

This public repository is the controlled update and binary distribution feed
for BradMisfit custom **Open WebUI Desktop** releases.

It intentionally contains release artifacts and updater metadata only, not the
private/custom Desktop source code. Installed custom Desktop clients use this
repository's public GitHub Releases to retrieve `latest.yml`, Windows NSIS
installers, blockmaps, and other platform artifacts. No personal GitHub token
is required by clients.

Each release includes `release-provenance.json` identifying its private source
commit and Desktop Remote Workspace protocol revision. Releases are built from
reviewed custom source and uploaded as drafts for acceptance before publication.

This is not the vanilla upstream Open WebUI Desktop release feed.
