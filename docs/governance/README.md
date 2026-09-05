# Governance

Governance documents define repository and contributor rules, including Issue
and Pull Request process, coding standards, and documentation placement and
language policy. They are normative repository governance.

Place rules that govern contribution and repository maintenance here. Do not
place product contracts, operational runbooks, test results, or design
exploration here.

- [Issue and Pull Request Governance](issues-and-pull-requests.md)
- [Executable coding standard](coding-standards.md)
- [Documentation migration inventory](documentation-migration.md)
- [Documentation placement and language policy](../README.md#placement-policy)

The repository's documentation policy is English-only for normative prose and
English by default for all documentation and governance text. The root
documentation index is the policy authority and the placement/link validator
is executed through `pnpm run test:standards`; this README makes that policy
discoverable from the governance category without defining a second rule set.
