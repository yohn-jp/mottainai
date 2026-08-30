# Runtime Appliance GHCR OCI Artifact

The canonical Runtime Appliance is distributed as a non-container OCI Artifact
in the public GHCR repository:

```text
ghcr.io/yohn-jp/mottainai/runtime-appliance
```

It is not a runnable container image. The OCI manifest has this artifact type
and exactly three file layers:

| OCI field | Value |
| --- | --- |
| artifact type | `application/vnd.mottainai.runtime.appliance.v1` |
| `.raw.zst` layer | `application/vnd.mottainai.runtime.appliance.raw.v1+zstd` |
| manifest layer | `application/vnd.mottainai.runtime.appliance.manifest.v1+json` |
| release metadata layer | `application/vnd.mottainai.runtime.appliance.release-metadata.v1+json` |

The commands below require ORAS CLI 1.2.0 or newer, `jq`, and `zstd`.

The published shape is the #627 bootstrap-only appliance contract: one
`mottainai-runtime-appliance.raw.zst`, one
`runtime-appliance-manifest.json`, and one
`runtime-appliance-release-metadata.json`. The raw image contains the stable
control/bootstrap substrate and `mottainai-bootstrap`; managed Mottainai,
Nawabari, Zellij, and coding-agent packages are resolved later into a managed
generation. Any retained managed package version fields are compatibility
metadata, not claims about base-closure contents.

## Resolve a digest, then pull by digest

`v<package-version>` is the compatibility locator for a matching Mottainai
release and `contract-v1` is the slower-changing contract locator. Both are
mutable OCI tags and neither is an identity. Record the descriptor digest and
use the `@sha256:...` reference for every pull and verification:

```sh
set -eu

repository=ghcr.io/yohn-jp/mottainai/runtime-appliance
locator_tag=v0.7.1

# Public packages need no login. For a private package, log in with a token
# that has read:packages only:
# printf '%s' "$GHCR_TOKEN" | oras login ghcr.io --username "$GHCR_USER" --password-stdin

descriptor="$(oras manifest fetch --no-tty --descriptor "$repository:$locator_tag")"
digest="$(printf '%s' "$descriptor" | jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))')"
artifact_ref="$repository@$digest"

oras manifest fetch --no-tty --pretty "$artifact_ref" > runtime-appliance-oci-manifest.json
jq -e \
  --arg artifact_type application/vnd.mottainai.runtime.appliance.v1 \
  --arg manifest_media_type application/vnd.oci.image.manifest.v1+json \
  --arg raw_media_type application/vnd.mottainai.runtime.appliance.raw.v1+zstd \
  --arg manifest_layer_media_type application/vnd.mottainai.runtime.appliance.manifest.v1+json \
  --arg metadata_layer_media_type application/vnd.mottainai.runtime.appliance.release-metadata.v1+json \
  '
    .schemaVersion == 2 and
    .mediaType == $manifest_media_type and
    .artifactType == $artifact_type and
    (.layers | length) == 3 and
    ([(.layers[] | .mediaType)] | sort) ==
      ([$raw_media_type, $manifest_layer_media_type, $metadata_layer_media_type] | sort)
  ' runtime-appliance-oci-manifest.json

mkdir -p runtime-appliance
oras pull --no-tty --output runtime-appliance "$artifact_ref"
```

The digest printed by the first command is the canonical distribution identity
to retain in deployment evidence. A later resolution of a convenience tag is
only a way to discover a digest; it must not replace the recorded digest ref.

## Verify the bytes and raw identity

The pulled layer names and metadata bind the compressed transport to the
canonical raw image. Verify them before importing or booting the disk:

```sh
set -eu
compressed=runtime-appliance/mottainai-runtime-appliance.raw.zst
manifest=runtime-appliance/runtime-appliance-manifest.json
metadata=runtime-appliance/runtime-appliance-release-metadata.json

test -s "$compressed"
test -s "$manifest"
test -s "$metadata"
test "$(jq -r '.canonicalManifest' "$metadata")" = "$(basename "$manifest")"
test "$(jq -r '.compressedAsset.filename' "$metadata")" = "$(basename "$compressed")"
test "$(jq -r '.compressedAsset.format' "$metadata")" = zstd
test "$(jq -r '.compressedAsset.sizeBytes' "$metadata")" = "$(stat -c '%s' "$compressed")"
test "$(jq -r '.compressedAsset.sha256' "$metadata")" = "$(sha256sum "$compressed" | awk '{print $1}')"
test "$(jq -r '.sourceRevision' "$metadata")" = "$(jq -r '.sourceRevision' "$manifest")"

zstd --decompress --no-progress -o runtime-appliance/mottainai-runtime-appliance.raw "$compressed"
raw=runtime-appliance/mottainai-runtime-appliance.raw
test "$(jq -r '.image.sizeBytes' "$manifest")" = "$(stat -c '%s' "$raw")"
test "$(jq -r '.image.sha256' "$manifest")" = "$(sha256sum "$raw" | awk '{print $1}')"
```

`oras pull` verifies layer digests while downloading; the manifest/layer type
check, release metadata checks, and raw manifest checks above additionally
prove that the pulled artifact is the intended Runtime Appliance contract.
