import { handleMetaConnectionApi } from "../../../../../server/connections/metaRuntime";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handleMetaConnectionApi(request);
