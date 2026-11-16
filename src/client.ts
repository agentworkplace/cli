import { createRequire } from "node:module";
import {
  AgentWorkplace,
  type AgentWorkplaceDeprecation,
} from "@agent-workplace/sdk";

/** This CLI release, as installed. */
export const { version: cliVersion } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string };
/** Names this CLI release in each API request's User-Agent. */
export const cliUserAgent = `agent-workplace-cli/${cliVersion}`;

/** Only commands without saved authority may select this origin by default. */
export const productionApiOrigin = "https://api.agentworkplace.dev";
/** Trusted only as the partner of the production API for invitation links. */
export const productionDashboardOrigin = "https://app.agentworkplace.dev";

/** SDK behavior the CLI needs from every product client it uses. */
export interface ProductClientConstruction {
  /** Reports deprecation notices on stderr; pass it to the SDK client. */
  onDeprecation?: (deprecation: AgentWorkplaceDeprecation) => void;
}

/** Optional SDK construction for callers of the programmatic CLI entry. */
export type CreateProductClient = (
  baseUrl: string,
  construction: ProductClientConstruction,
) => AgentWorkplace;

export interface ProductClientOptions extends ProductClientConstruction {
  createProductClient?: CreateProductClient | undefined;
}

export function productClient(
  options: ProductClientOptions,
  baseUrl: string,
): AgentWorkplace {
  const construction = constructionOf(options);
  if (options.createProductClient !== undefined)
    return options.createProductClient(baseUrl, construction);
  return new AgentWorkplace({
    baseUrl,
    userAgent: cliUserAgent,
    ...construction,
  });
}

export function constructionOf(
  options: ProductClientConstruction,
): ProductClientConstruction {
  return options.onDeprecation === undefined
    ? {}
    : { onDeprecation: options.onDeprecation };
}
