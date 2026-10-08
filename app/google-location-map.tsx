'use client';
import { MapPin, ExternalLink } from 'lucide-react';
import { googleMapsSearchUrl } from '@/lib/location-search';
export default function GoogleLocationMap({ query, label, height = 430 }: { query: string; label: string; height?: number }) {
  const source = 'https://maps.google.com/maps?' + new URLSearchParams({ q: query, output: 'embed' });
  return <section className="google-location-map" aria-label="Google Maps location">
    <div className="google-map-heading"><div><MapPin size={18}/><span>{label}</span></div>
      <a href={googleMapsSearchUrl(query)} target="_blank" rel="noreferrer">Open Google Maps<ExternalLink size={14}/></a>
    </div>
    <iframe src={source} title={'Google Maps: ' + label} height={height} width="100%" loading="lazy"
      allowFullScreen referrerPolicy="strict-origin-when-cross-origin"/>
  </section>;
}
