import { createFixtureQuery } from "../semantics/fixtures/dashboard-fixture.js";
import { createLiveRepositoryQuery } from "../semantics/model/index.js";
import type { RepositorySemanticQuery } from "../semantics/query.js";

export type DashboardProvider = "fixture" | "live";

export const DASHBOARD_PROVIDER_ENV = "MOTTAINAI_DASHBOARD_PROVIDER" as const;

export function parseDashboardProvider(value: string | undefined): DashboardProvider {
  if (value === undefined || value.trim().length === 0) return "fixture";
  const normalized = value.trim().toLowerCase();
  if (normalized === "fixture" || normalized === "live") return normalized;
  throw new Error(`invalid dashboard provider: ${value} (expected fixture or live)`);
}

export function configuredDashboardProvider(environment: NodeJS.ProcessEnv = {}): DashboardProvider {
  return parseDashboardProvider(environment[DASHBOARD_PROVIDER_ENV]);
}

export function createDashboardQuery(provider: DashboardProvider, rootDir: string): RepositorySemanticQuery {
  if (provider === "fixture") return createFixtureQuery();
  return createLiveRepositoryQuery({ rootDir });
}
