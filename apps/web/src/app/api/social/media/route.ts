import { handleSocialMediaApi } from "../../../../server/social/mediaApi";
export const POST = (request: Request) => handleSocialMediaApi(request);
