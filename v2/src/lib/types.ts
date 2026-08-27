export type ApiBody = Record<string, any>;
export type ApiResult = Record<string, any>;
export type Handler = (body: ApiBody) => Promise<ApiResult>;
