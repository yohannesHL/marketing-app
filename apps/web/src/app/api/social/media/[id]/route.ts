import { handleSocialMediaApi } from "../../../../../server/social/mediaApi";
type Context = { params: Promise<{ id: string }> };
export const GET = async (request: Request, context: Context) => handleSocialMediaApi(request, (await context.params).id);
export const DELETE = async (request: Request, context: Context) => handleSocialMediaApi(request, (await context.params).id);
