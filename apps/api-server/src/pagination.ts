export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 200;

export interface PageQuery {
  limit?: string;
  offset?: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export function parsePagination(
  query: PageQuery,
  opts?: { defaultLimit?: number; maxLimit?: number },
): { limit: number; offset: number } {
  const defaultLimit = opts?.defaultLimit ?? DEFAULT_PAGE_LIMIT;
  const maxLimit = opts?.maxLimit ?? MAX_PAGE_LIMIT;
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), maxLimit);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

/** mysql2 execute() 不支持 LIMIT/OFFSET 占位符，需内联已校验的整数 */
export function sqlLimitOffset(
  limit: number,
  offset: number,
  maxLimit = MAX_PAGE_LIMIT,
): string {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || DEFAULT_PAGE_LIMIT, 1), maxLimit);
  const safeOffset = Math.max(Math.floor(offset) || 0, 0);
  return ` LIMIT ${safeLimit} OFFSET ${safeOffset}`;
}

export function slicePage<T>(items: T[], limit: number, offset: number): PageResult<T> {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}
