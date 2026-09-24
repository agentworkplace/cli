import { AgentWorkplace } from "@agent-workplace/sdk";

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
