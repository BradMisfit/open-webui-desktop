# Custom Open WebUI Desktop releases

This private/custom Desktop source builds update artifacts for the public
distribution feed [`BradMisfit/open-webui-desktop`](https://github.com/BradMisfit/open-webui-desktop).
The public repository contains release metadata and binaries only; it is not a
source mirror.

## Identity and versions

- Application identity: `com.openwebui.desktop` (kept stable for in-place upgrades)
- Product name: `Open WebUI`
- Windows executable: `open-webui.exe`
- Custom release form: `MAJOR.MINOR.PATCH-bradmisfit.N`, for example
  `0.0.21-bradmisfit.1`.

The source commit and Remote Workspace protocol revision are uploaded as
`release-provenance.json` with each release. The current target protocol is 1.

## Controlled release procedure

1. Choose and review the source commit in this private Desktop repository.
2. Set the exact custom version in `package.json` and `package-lock.json`.
3. Run the `Build Custom Desktop Release` workflow manually with the same
   `release_version` and `create_draft_release=true`.
4. The workflow runs its build matrix, produces Windows NSIS installer,
   `.blockmap`, and `latest.yml`, then validates SHA-512, sizes, filenames and
   the blockmap before uploading a **draft** GitHub release to the public feed.
5. Perform Windows update acceptance from an older custom build. Publish the
   draft only after that acceptance succeeds.

The private source repository must define `RELEASE_FEED_TOKEN`, a narrowly
scoped CI secret allowed to create releases in `BradMisfit/open-webui-desktop`.
It is never embedded in a Desktop build. A missing secret makes publication
fail; the updater never falls back to upstream releases.

## Recovery

Keep older published release assets. Do not silently downgrade clients: publish
a newer corrective custom version instead. If a Desktop protocol incompatibility
is found, the existing `DESKTOP_UPDATE_REQUIRED` response remains fail-closed;
release a compatible Desktop update before tightening server requirements.

Windows builds are currently unsigned unless a valid signing secret is supplied
to CI. They still validate updater artifact SHA-512 metadata, but Windows
SmartScreen may warn until trusted code signing is configured.
