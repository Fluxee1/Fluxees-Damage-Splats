# Foundry release registration

The repository's Actions secret `FOUNDRY_PACKAGE_RELEASE_TOKEN` must contain this
package's complete Foundry token, including its `fvttp_` prefix. The workflow uses
the token directly as the Authorization header, without a Bearer prefix. Never
put the token in source files or workflow inputs.

Future version-matching `*-Release` tags publish GitHub assets first, then verify
the public manifest and ZIP against the tagged source and reviewed asset hashes
before registering that version with Foundry. Compatibility comes from the
published manifest and is not changed by registration.

For an existing GitHub release, open Actions, select the release workflow, and
choose Run workflow on main. Enter its exact release tag. Leave `dry_run` enabled
to validate without saving. Disable it only when registering an unregistered
release or recovering a failed registration; this path never republishes GitHub
assets. A duplicate dry-run can fail even when the credentials are valid.

Rate limits honor Retry-After with bounded retries. Validation errors fail without
retry. Timeouts and server errors require checking the public Foundry package
directory before retrying. Exact version and immutable manifest matches prevent
repeat registration. A missing or delayed directory entry leaves the result
uncertain; inspect the package management page before another manual write.

API reference: https://foundryvtt.com/article/package-release-api/
