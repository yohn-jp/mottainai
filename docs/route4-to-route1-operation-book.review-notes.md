# Route 4 -> Route 1 operation-book review notes

This temporary review companion for Issue #848 captures the intended review method for the first operation-book PR. It is deliberately small and may be folded into or removed from the main operation book before merge.

Review the chronological ledger by handoff rather than by file ownership:

1. `R4-15 / H4-3`: selected release provider identity -> verified managed Lima/QEMU/SSH provider state.
2. `R3-12 / H3-B`: provider lifecycle -> authenticated canonical guest -> canonical guest health.
3. `R3-15 / H3-2`: host orchestration -> guest managed-runtime authority.
4. `R2-08 / H2-1`: healthy exact managed generation -> exact canonical Route 1 payload -> functional CLI/MCP.

For each handoff, reject any undocumented ambient dependency, duplicate identity authority, unpersisted state required by a later step, or proof that uses a surrogate path instead of the production consumer.

Known first-pass defects are tracked by #826, #840, #841, #842, #843, #844, #845, #846 and #847. Final external certification remains #261.
