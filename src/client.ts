import { AgentWorkplace } from "@agent-workplace/sdk";

/** Only commands without saved authority may select this origin by default. */
export const productionApiOrigin = "https://api.agentworkplace.dev";

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
  return new AgentWorkplace({ baseUrl });
}
