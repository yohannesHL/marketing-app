import { handlePaidAccountRoutingApi } from "../../../../server/connections/paidAccountRouting";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handlePaidAccountRoutingApi(request);
