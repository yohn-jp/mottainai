import type {
  AllocateRepositoryPrincipalInput,
  AllocateRepositoryPrincipalResult,
  ListRepositoryPrincipalsOptions,
  ProveRepositoryPrincipalCleanupInput,
  ReleaseRepositoryPrincipalInput,
  RepositoryPrincipalRecord,
  WorkflowStateStore,
} from "../state/store.js";

/** Public, bounded projection for diagnostics; no paths, remotes, or secrets. */
export interface RepositoryPrincipalStatus {
  schemaVersion: RepositoryPrincipalRecord["schemaVersion"];
  allocationId: string;
  repositoryId: RepositoryPrincipalRecord["instanceId"];
  lifecycleState: RepositoryPrincipalRecord["lifecycleState"];
  uid: number;
  gid: number;
  internalUsername: string;
  allocatedAt: number;
  releasedAt: number | undefined;
  cleanupProvenAt: number | undefined;
}

export function projectRepositoryPrincipalStatus(record: RepositoryPrincipalRecord): RepositoryPrincipalStatus {
  return {
    schemaVersion: record.schemaVersion,
    allocationId: record.allocationId,
    repositoryId: record.instanceId,
    lifecycleState: record.lifecycleState,
    uid: record.uid,
    gid: record.gid,
    internalUsername: record.internalUsername,
    allocatedAt: record.allocatedAt,
    releasedAt: record.releasedAt,
    cleanupProvenAt: record.cleanupProvenAt,
  };
}

/** Thin domain façade; SQLite remains the persistence/transaction authority. */
export class RepositoryPrincipalAllocator {
  constructor(
    private readonly store: Pick<
      WorkflowStateStore,
      | "allocateRepositoryPrincipal"
      | "releaseRepositoryPrincipal"
      | "proveRepositoryPrincipalCleanup"
      | "getRepositoryPrincipal"
      | "listRepositoryPrincipals"
    >,
  ) {}

  allocate(input: AllocateRepositoryPrincipalInput): AllocateRepositoryPrincipalResult {
    return this.store.allocateRepositoryPrincipal(input);
  }

  release(input: ReleaseRepositoryPrincipalInput): RepositoryPrincipalRecord {
    return this.store.releaseRepositoryPrincipal(input);
  }

  proveCleanup(input: ProveRepositoryPrincipalCleanupInput): RepositoryPrincipalRecord {
    return this.store.proveRepositoryPrincipalCleanup(input);
  }

  get(repositoryId: RepositoryPrincipalRecord["instanceId"]): RepositoryPrincipalRecord | undefined {
    return this.store.getRepositoryPrincipal(repositoryId);
  }

  status(options?: ListRepositoryPrincipalsOptions): RepositoryPrincipalStatus[] {
    return this.store.listRepositoryPrincipals(options).map(projectRepositoryPrincipalStatus);
  }
}
