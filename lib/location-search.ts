export type LocationFields = { road: string; area: string; city: string; district: string };
export function locationLabel(fields: LocationFields) {
  const seen = new Set<string>();
  return [fields.road, fields.area, fields.city, fields.district].map(part => part.trim().replace(/\s+/g, ' '))
    .filter(part => {
      if (!part || seen.has(part.toLocaleLowerCase())) return false;
      seen.add(part.toLocaleLowerCase()); return true;
    }).join(', ');
}
export function locationTerms(address: string) {
  return [...new Set(address.split(/[,\u060c]/).map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean))];
}
export function googleMapsSearchUrl(query: string) {
  return 'https://www.google.com/maps/search/?' + new URLSearchParams({ api: '1', query });
}
export function googleMapsDirectionsUrl(lat: number, lng: number) {
  return 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', destination: lat + ',' + lng });
}
