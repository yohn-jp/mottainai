import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * OAuth tokenをMottainaiへ渡さず、認証済みbrokerのMCP endpointだけ解決する契約。
 * targetUrlはproviderがどのremote server向けか判定するためだけに使う。
 */
export interface OAuthCredentialProvider {
  resolveEndpoint(targetUrl: URL, profile: string): Promise<URL | string>;
}

function isOAuthCredentialProvider(value: unknown): value is OAuthCredentialProvider {
  return typeof value === "object"
    && value !== null
    && typeof (value as { resolveEndpoint?: unknown }).resolveEndpoint === "function";
}

class BrokerEndpointValidationError extends Error {
  constructor(profile: string, reason?: "userinfo") {
    super(
      `oauth broker returned invalid endpoint: ${profile}${reason === "userinfo" ? "; userinfo is not allowed" : ""}`,
    );
    this.name = "BrokerEndpointValidationError";
  }
}

function brokerUrl(value: URL | string, profile: string): URL {
  let endpoint: URL;
  try {
    endpoint = value instanceof URL ? value : new URL(value);
  } catch {
    throw new BrokerEndpointValidationError(profile);
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new BrokerEndpointValidationError(profile);
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new BrokerEndpointValidationError(profile, "userinfo");
  }
  return endpoint;
}

export async function resolveBrokerEndpoint(
  provider: OAuthCredentialProvider,
  targetUrl: URL,
  profile: string,
): Promise<URL> {
  try {
    return brokerUrl(await provider.resolveEndpoint(targetUrl, profile), profile);
  } catch (error) {
    if (error instanceof BrokerEndpointValidationError) {
      throw error;
    }
    throw new Error(`oauth broker resolution failed: ${profile}`);
  }
}

/** gateway起動時にhost側のbroker provider moduleを読み込む。 */
export async function loadOAuthCredentialProvider(
  modulePath: string | undefined,
  baseDirectory: string,
): Promise<OAuthCredentialProvider | undefined> {
  if (modulePath === undefined) return undefined;
  const moduleUrl = pathToFileURL(path.resolve(baseDirectory, modulePath)).href;
  const loaded = await import(moduleUrl) as { default?: unknown; oauthCredentialProvider?: unknown };
  const provider = loaded.default ?? loaded.oauthCredentialProvider;
  if (!isOAuthCredentialProvider(provider)) {
    throw new Error("invalid oauth credential provider module");
  }
  return provider;
}
