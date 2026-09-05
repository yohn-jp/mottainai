# Immutable deployment descriptor

`mottainai.deployment.v1` is the release-level identity graph defined by
ADR-0003 and Issue #755. It is one small JSON document, published as a
versioned release asset together with a SHA-256 sidecar. It is not a package
manager or a mutable `latest` catalog.

For the normative **chronological** Route 4 → Route 1 consumer sequence—what
reads this descriptor, which identity is consumed at each handoff, what state
may change, and what proves the next transition—see
[`route4-route1-operation-book.md`](route4-route1-operation-book.md). This file
remains the descriptor field/identity contract; it is not a competing
end-to-end execution sequence.

## Contract

The descriptor has one `release` authority (`version`, `tag`, and the exact
40-character source revision) and the supported `linux-x86_64` profile.
`route1` binds the canonical packed npm payload; `route2` binds the managed
generation inputs and identity; `route3` binds the Runtime Appliance OCI
manifest digest and raw image identity; and `route4` binds the standalone
`mottainai-init` artifact plus an explicit Lima/QEMU provisioning profile.

Mottainai-owned entries are rejected unless their version and source revision
match the release. The Appliance must use an immutable `sha256:` OCI digest,
not a tag. Lima and QEMU remain external provider dependencies: their pinned
artifact identities and compatibility requirements are recorded for selection
and verification, while Lima retains VM lifecycle and QEMU topology
ownership. The canonical Route 4 golden path is the `pinned-verified-archives`
provisioning strategy: QEMU's descriptor identity is an `executable-digest`
carrying the reviewed `qemu-system-x86_64`/`qemu-img` archive digests
(`systemBinary`/`imageBinary`) that Route 4 materializes and attests before
Lima is launched. An `explicit-adoption` profile remains available only for an
operator-supplied external installation; it is not the canonical fresh-host
path.

Unknown schema versions, missing identities, mutable-only locators,
cross-release revisions, mismatched managed-generation identities, and
incompatible provider profiles fail closed.

## Canonical identity and publication

Object keys are sorted lexicographically and managed package entries are
sorted by `packageId`; the UTF-8 canonical JSON (without a trailing newline)
is hashed with SHA-256. Its `.sha256` sidecar covers those exact canonical
bytes. Consumers should verify the sidecar before parsing,
then parse with the bounded contract.

Release generation uses the repository-owned validator:

```sh
node --import tsx scripts/build-deployment-descriptor.mjs \
  --input descriptor-input.json \
  --output mottainai-deployment-v1.json \
  --identity-output mottainai-deployment-v1.json.sha256
```

The input is assembled only after all Mottainai-owned artifact identities are
available. Release fan-in can use
`scripts/create-release-deployment-descriptor-input.mjs`, which requires the
actual managed-generation identity inputs and the reviewed provider profile;
it never invents missing digests. Historical descriptors remain independently retrievable from the
matching immutable GitHub Release asset; URLs and release tags are locators,
never substitutes for the recorded digests.

## Golden path

Select one exact release descriptor, verify its sidecar, and use its profile
to derive Route 3's Appliance reference, Route 2's managed-generation intent,
and Route 4's provider requirements. Advanced `RuntimeSpec`/digest/provider
overrides remain available for diagnostics, but are not required for normal
release composition. A descriptor is not complete merely because it identifies
an installable binary: the selected Route 3/4 consumer must still perform its
own artifact verification and functional readiness checks.
