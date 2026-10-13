import { handleMetaConnectionApi } from "../../../../../server/connections/metaRuntime";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleMetaConnectionApi(request);
