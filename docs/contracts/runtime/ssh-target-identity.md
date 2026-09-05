# SSH target identity contract

The SSH target registry from Issue #298 is a transport authority separate from
Runtime identity. A record's `targetId` identifies the logical target, while
`connectionId` identifies the currently verified transport binding. Changing
the hostname, port, or user does not change Runtime identity.

The initial connection is not TOFU. The caller must independently obtain the
host key's OpenSSH public-key material and SHA-256 fingerprint, verify that the
fingerprint and algorithm calculated from the material match, and record
operator trust with `trustAction: "explicit"` before connecting. Reconnection
is denied unless it matches the stored fingerprint. The real SSH process
receives a temporary `known_hosts` file generated only from registry material,
with `StrictHostKeyChecking=yes` and `GlobalKnownHostsFile=/dev/null` forced.
An updated fingerprint is never accepted automatically; only explicit trust
and an independently verified match with the stored Runtime identity may create
a new connection binding through `rebind`.

Persistent state stores coordinates, public host-key material and fingerprint,
trust provenance, and Runtime identity only. It does not store private keys,
agent secrets, tokens, or command output. Runtime binding and rebind evidence is
parsed with the existing `RuntimeCapabilityResultSchema`; a raw identity string
is not an authority.
