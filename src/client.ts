import { createRequire } from "node:module";
import { AgentWorkplace } from "@agent-workplace/sdk";

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

/** Optional SDK construction for callers of the programmatic CLI entry. */
export type CreateProductClient = (baseUrl: string) => AgentWorkplace;

export interface ProductClientOptions {
  createProductClient?: CreateProductClient | undefined;
}

export function productClient(
  options: ProductClientOptions,
  baseUrl: string,
): AgentWorkplace {
  if (options.createProductClient !== undefined)
    return options.createProductClient(baseUrl);
  return new AgentWorkplace({ baseUrl, userAgent: cliUserAgent });
}
