# Verifying a BAYZ release

> Phase 9K Task 5. Enforced by `tests/release-signing.test.mjs` and `scripts/verify-release.mjs`.

Every BAYZ release artifact ships with a `SHA256SUMS` manifest. Hosted releases additionally carry
keyless Sigstore-style provenance obtained through GitHub OIDC. This page explains how to check both,
and — just as importantly — **what a successful check does not prove**.

## 1. Verify the digests, with no BAYZ tooling

`SHA256SUMS` is in standard `sha256sum` format, so you do not need anything from this project:

```sh
cd <release directory>
sha256sum -c SHA256SUMS
```

Every line must say `OK`. This is the check to run if you trust nothing else here.

The equivalent through the repository's own script, which also inspects the signature:

```sh
node scripts/verify-release.mjs --dir <release directory>
```

## 2. Verify the signature, when one is present

```sh
node scripts/verify-release.mjs --dir <release directory> --pubkey <path to the public key>
```

Three outcomes, deliberately distinct:

| Output | Exit | Meaning |
| --- | --- | --- |
| `signature: VERIFIED` | 0 | The manifest was signed by the holder of that key. |
| `UNVERIFIED: no signature present` | 0 | No signature exists. Normal for a local build. |
| `signature: INVALID` | 1 | A signature exists and does not verify. **Do not install.** |

**Unsigned and forged are not the same thing, and this tooling never conflates them.** If they
produced the same result, an attacker who stripped a signature would be treated exactly like an honest
local build — which is the confusion signing exists to prevent.

## 3. Release modes

BAYZ distinguishes three states, and only the third is a signed release.

### Local development build

What you get from `node scripts/pack.mjs` on a developer machine, including the Termux/Android device
this project is currently developed on.

- Digest manifest: **yes**, always.
- Signature: **no**. `scripts/sign-release.mjs` prints `UNVERIFIED: unsigned build` and exits 0.
- Report it as: **local, unsigned**.

Being unsigned is not an error and does not block local work. It is simply not a release.

### Release candidate validation

A local build that has passed the full supply-chain gate: audit policy, lockfile integrity, licence
consistency, SBOM validation, digest manifest.

- Everything above is checked and must pass.
- Signature and provenance remain **UNVERIFIED** — no OIDC identity exists off hosted CI.
- Report it as: **validated, unsigned**.

### Hosted signed release

Performed by `.github/workflows/release-provenance.yml` on GitHub-hosted runners.

- Identity comes from **GitHub's OIDC provider**, short-lived, issued per workflow run.
- **No long-lived private signing key exists**: not in this repository, not in its history, not on any
  developer device. There is nothing to leak, rotate, or steal.
- `id-token: write` is granted **only** to the job that performs signing, and nowhere else.
- Report it as: **hosted, signed, provenance attached**.

### Current status of this repository

**Hosted signing has never executed and is therefore UNVERIFIED.** No remote is configured, no
workflow has ever run, and `cosign` is not installed on the development device. The workflow is
committed and inert so that it can run unchanged once a remote exists.

This is stated plainly rather than being left to inference: nothing in this repository has been signed,
and no output of any script here claims otherwise.

## 4. What verification does not prove

A valid signature and matching digests establish exactly one thing: **these bytes are the bytes that
were signed.** In particular they do **not** prove:

- **That the artifact is reproducible.** BAYZ pins tar and gzip metadata so two packs of an unchanged
  tree are byte-identical, but the toolchain that produced it is not itself pinned. A different Node or
  npm version may legitimately produce different bytes. See `docs/superpowers/2026-08-27-bayz-build-determinism.md`.
- **That the build machine was uncompromised.** Signing attests to the artifact's identity, not to the
  integrity of the host that built it. A compromised builder produces a correctly signed backdoor.
- **That the source is free of vulnerabilities.** `scripts/audit-check.mjs` covers known advisories in
  declared dependencies. It says nothing about undiscovered flaws or about BAYZ's own code.
- **That the dependencies are trustworthy.** The SBOM and licence inventory describe what ships; they
  make no judgement about whether those packages deserve your trust.
- **Who the signer is, in the local-key case.** An `openssl` signature proves possession of a key, not
  the identity of a person. Only the hosted keyless path binds a signature to a verifiable workflow
  identity.

## 5. Reporting rules

For anyone automating around this:

- Never describe a local artifact as signed.
- Never report a missing signature as a failure, or a bad signature as merely missing.
- Never report hosted OIDC signing as `PASS` on a run where it did not execute. `UNVERIFIED` is the
  honest and correct value, and the gate is built to accept it for local and release-candidate modes
  while requiring it for a hosted release.
