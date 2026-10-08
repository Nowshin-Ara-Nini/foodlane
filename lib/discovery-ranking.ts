type Signals = { seller_id: string; recommendation_count: number; interest_count: number; demo?: boolean };

export function mostRecommended<T extends Signals>(shops: T[]) {
  return shops.filter(shop => !shop.demo && shop.recommendation_count > 0)
    .sort((a, b) => b.recommendation_count - a.recommendation_count || a.seller_id.localeCompare(b.seller_id));
}

export function mostInterested<T extends Signals>(shops: T[]) {
  return shops.filter(shop => !shop.demo && shop.interest_count > 0)
    .sort((a, b) => b.interest_count - a.interest_count || a.seller_id.localeCompare(b.seller_id));
}
