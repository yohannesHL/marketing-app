import { handleProviderCatalog } from "../../../../server/connections/providerCatalog";
export const GET = (request: Request) => handleProviderCatalog(request);
