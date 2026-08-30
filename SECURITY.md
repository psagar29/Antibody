# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting channel for this repository. If unavailable, contact the maintainer privately through the contact method on the maintainer's GitHub profile.

Include affected version, impact, reproduction steps, and suggested mitigation. Do not include credentials, private repository content, customer data, or active exploit details. Revoke any credential that may have been exposed before reporting it.

## Supported versions

Only the latest 0.1.x release receives security fixes. Antibody is early-stage software; no production-readiness claim is made.

## Operational warning

Live recovery evaluates untrusted repository code in remote Runloop Devboxes. Use a restrictive Network Policy, immutable Blueprint or Snapshot, disposable credentials, bounded commands, and a hard budget. Inspect cleanup records and confirm Devboxes are shut down. Never expose the local dashboard on an untrusted network.

Publication requires a separate GitHub write credential and the exact human-approved receipt digest. Antibody can create only a draft PR, but the operator must review its files, evidence, and limitations before any merge.

See [docs/security-model.md](docs/security-model.md) for trust boundaries and known limits.
