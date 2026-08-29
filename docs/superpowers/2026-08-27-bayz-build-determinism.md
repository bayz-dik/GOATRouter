# BAYZ build determinism

> Phase 9K Task 6. Produced and re-measured by `scripts/build-determinism.mjs`; enforced by
> `tests/build-determinism.test.mjs`.

**BAYZ does not claim reproducible builds.** That phrase is a term of art meaning something far stronger
than "two runs on one machine matched", and this document is careful not to borrow its authority. What
follows is what was measured, on which toolchain, and what remains unknown.

## Toolchain measured

| | |
| --- | --- |
| Node | v24.19.0 |
| Platform | linux arm64 (Termux/Android under proot) |
| npm | 11.17.0 |
| Bundlers | `esbuild` (server bundle, inside `scripts/pack.mjs`), `vite` (dashboard) |

A different Node, npm, or bundler version may legitimately produce different bytes. Nothing here pins
the toolchain, so nothing here should be read as a cross-machine guarantee.

## Verdict per artifact class

| Class | Verdict | Basis |
| --- | --- | --- |
| `tsc-emitted-output` | `N/A` | Nothing is emitted to compare. |
| `release-tarball` | `PASS` | Two packs of an unchanged tree are byte-identical. |
| `dashboard-bundle` | `UNVERIFIED` | `vite` promises no byte reproducibility; not compared across a rebuild. |
| `sbom` | `PASS` | Two generations at a pinned timestamp are identical. |
| `build-machine-identity` | `PASS` | No absolute path, home directory, username, or hostname in shipped bytes. |

### `tsc-emitted-output` — `N/A`, and why

The Phase 9K plan expected `tsc`-emitted JavaScript to compare. There is none. **All eleven workspace
`build` scripts are `tsc -p tsconfig.json --noEmit`** — type checking only, with `noEmit` measured from
each manifest rather than assumed. The shipped JavaScript is produced by `esbuild` and `vite`.

Comparing byte-identity across an empty set of files would pass trivially and prove nothing, so this
class reports `N/A` with its reason. If emitted output ever appears, the script digests it instead of
silently keeping the `N/A`.

### `release-tarball` — `PASS`

The one determinism property BAYZ genuinely earns, inherited from Phase 9J: `scripts/pack.mjs` pins tar
`mtime`, uid, and gid, and gzip writes a zero MTIME. Measured by packing twice and comparing SHA-256,
not by restating the 9J note.

This holds **on this machine with this toolchain**. It is not a claim that a different machine produces
the same bytes.

### `dashboard-bundle` — `UNVERIFIED`

`vite` makes no byte-reproducibility promise, so failing a build over it would be demanding a standard
the tool never offered. The bundle's content-hashed asset names and digests are recorded, but they are
**not** compared across a rebuild: that rebuild is the heaviest in the tree and is not run inside the
test suite on this device.

`UNVERIFIED` is therefore the honest verdict — not measured, and not claimed. The run exits 0 anyway,
because an unmeasured property is not a defect.

### `build-machine-identity` — `PASS`

The achievable half, and the one that matters for privacy. The **tarball** is scanned, not the source
tree, because the bundler is what would embed a path and the tarball is what a user receives. Every
shipped file is extracted and checked for the repository's absolute path, home-directory prefixes,
Windows build paths, CI workspace paths, and a distinctive username or hostname.

The scan has a **positive control**: a test plants known identity strings and asserts they are caught. A
scan that silently matched nothing would report `PASS` forever, which is worse than no scan because it
reads as protection.

## A false positive worth recording

The first run reported `FAIL` on `package/dist/server.mjs` for leaking the build hostname `localhost`.

That was the scanner being wrong, not the artifact. `localhost` is this device's actual hostname *and* a
legitimate shipped string: it appears nine times in the server bundle as part of the SSRF loopback
allowlist (`localhost`, `localhost.localdomain`, `ip6-localhost`). Reporting it would have meant either
a permanent false failure or — much worse — deleting a Fortress protection to satisfy a scanner.

Generic hostnames and usernames are now exempt, which costs nothing: knowing the builder was called
`localhost` or `root` tells an attacker precisely nothing.

## What this does not tell you

- Nothing here proves a **different machine** reproduces these bytes. Only two runs on one host were
  compared.
- Nothing here pins the toolchain. A Node or bundler upgrade may change output legitimately.
- `build-machine-identity: PASS` means no identity was found by these patterns, not that none exists.
- The dashboard bundle is genuinely unmeasured across rebuilds. Treat `UNVERIFIED` as "unknown", not as
  "probably fine".
