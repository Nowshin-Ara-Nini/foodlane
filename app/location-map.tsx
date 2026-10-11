'use client';

import { useEffect, useRef, useState } from 'react';
import { googleMapsSearchUrl } from '@/lib/location-search';

export type Point = { lat: number; lng: number };
type Pin = Point & { id: string; name: string };
type Props = { center?: Point; pins?: Pin[]; onPick?: (point: Point) => void; height?: number };
const fallback: Point = { lat: 23.746, lng: 90.373 };

type GoogleMapApi = {
  Map: new (host: HTMLElement, options: Record<string, unknown>) => GoogleMapInstance;
  Marker: new (options: Record<string, unknown>) => GoogleMarker;
  event: { clearInstanceListeners(target: object): void };
};
type GoogleMapInstance = {
  setCenter(point: Point): void;
  setZoom(zoom: number): void;
  getZoom(): number;
  addListener(event: string, handler: (event: { latLng?: { lat(): number; lng(): number } }) => void): GoogleListener;
};
type GoogleMarker = { setMap(map: GoogleMapInstance | null): void; setPosition(point: Point): void; addListener(event: string, handler: (event: { latLng?: { lat(): number; lng(): number } }) => void): GoogleListener };
type GoogleListener = { remove(): void };
declare global { interface Window { google?: { maps: GoogleMapApi } } }

let mapsScript: Promise<GoogleMapApi | null> | undefined;
function loadGoogleMaps(): Promise<GoogleMapApi | null> {
  const key = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return Promise.resolve(null);
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (!mapsScript) {
    mapsScript = new Promise(resolve => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-foodlane-google-maps]');
      const script = existing ?? document.createElement('script');
      const done = () => resolve(window.google?.maps ?? null);
      script.addEventListener('load', done, { once: true });
      script.addEventListener('error', done, { once: true });
      if (!existing) {
        script.dataset.foodlaneGoogleMaps = 'true';
        script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key, loading: 'async', v: 'weekly' });
        script.async = true;
        document.head.appendChild(script);
      }
      if (existing && window.google?.maps) done();
    });
  }
  return mapsScript;
}

export default function LocationMap({ center = fallback, pins = [], onPick, height = 320 }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<GoogleMapInstance | null>(null);
  const markers = useRef<GoogleMarker[]>([]);
  const pick = useRef(onPick);
  const [ready, setReady] = useState(false);
  const [mapsAvailable, setMapsAvailable] = useState(false);
  const [error, setError] = useState('');
  const lat = Number.isFinite(center.lat) ? center.lat : fallback.lat;
  const lng = Number.isFinite(center.lng) ? center.lng : fallback.lng;
  const editable = !!onPick;
  const embedUrl = 'https://maps.google.com/maps?' + new URLSearchParams({ q: `${lat},${lng}`, output: 'embed', z: '14' });

  useEffect(() => { pick.current = onPick; }, [onPick]);
  useEffect(() => {
    let cancelled = false;
    let clickListener: GoogleListener | undefined;
    void loadGoogleMaps().then(api => {
      if (cancelled) return;
      if (!api || !host.current) { setMapsAvailable(false); return; }
      try {
        const instance = new api.Map(host.current, {
          center: { lat, lng }, zoom: 14, mapTypeControl: false, streetViewControl: false,
          fullscreenControl: true, clickableIcons: false, gestureHandling: 'cooperative',
        });
        map.current = instance;
        clickListener = instance.addListener('click', event => {
          const point = event.latLng;
          if (point) pick.current?.({ lat: point.lat(), lng: point.lng() });
        });
        setMapsAvailable(true);
        setReady(true);
      } catch {
        setError('Google Maps could not load. Check the browser key and its Maps JavaScript API restrictions.');
        setMapsAvailable(false);
      }
    });
    return () => {
      cancelled = true;
      clickListener?.remove();
      markers.current.forEach(marker => marker.setMap(null));
      markers.current = [];
      map.current = null;
    };
  // The map is created once; later center and marker changes are handled below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready && map.current) map.current.setCenter({ lat, lng });
  }, [ready, lat, lng]);

  useEffect(() => {
    if (!ready || !map.current || !window.google?.maps) return;
    markers.current.forEach(marker => marker.setMap(null));
    markers.current = [];
    const api = window.google.maps;
    for (const pin of pins) {
      const marker = new api.Marker({
        map: map.current, position: { lat: pin.lat, lng: pin.lng }, title: pin.name,
        url: `/sellers/${encodeURIComponent(pin.id)}`,
      });
      marker.addListener('click', () => { window.open(`/sellers/${encodeURIComponent(pin.id)}`, '_self'); });
      markers.current.push(marker);
    }
    if (editable) {
      const marker = new api.Marker({ map: map.current, position: { lat, lng }, draggable: true, title: 'Selected location: drag to move' });
      marker.addListener('dragend', event => {
        if (event.latLng) pick.current?.({ lat: event.latLng.lat(), lng: event.latLng.lng() });
      });
      markers.current.push(marker);
    }
  }, [ready, pins, lat, lng, editable]);

  return <div>
    {mapsAvailable
      ? <div ref={host} className="location-map" style={{ height, position: 'relative', zIndex: 0 }} aria-label={editable ? 'Choose a location by clicking the Google map or dragging the pin' : 'Approved food seller locations on Google Maps'} />
      : <div className="google-map-fallback" style={{ height }}>
          <iframe src={embedUrl} title="Google Maps location" width="100%" height="100%" loading="lazy" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
          {editable && <a className="google-map-open" href={googleMapsSearchUrl(`${lat},${lng}`)} target="_blank" rel="noreferrer">Open this location in Google Maps</a>}
        </div>}
    {error && <p role="status" className="small">{error}</p>}
    {editable && !import.meta.env?.VITE_GOOGLE_MAPS_API_KEY && <p className="small">To pick a pin directly on this map, configure a Google Maps browser key for Foodlane. Until then, enter the coordinates below or use “Use my location”.</p>}
  </div>;
}

export function LocationPicker({ initial = fallback, latName = 'lat', lngName = 'lng' }: { initial?: Point; latName?: string; lngName?: string }) {
  const [point, setPoint] = useState(initial), [message, setMessage] = useState('');
  return <div className="full stack">
    <LocationMap center={point} onPick={setPoint}/>
    <p className="small">Click the Google map or drag the pin to your selling place. Home cooks can choose a nearby pickup point.</p>
    <div className="form-grid">
      <label className="field">Latitude<input name={latName} type="number" step="any" min="-90" max="90" required value={point.lat} onChange={e=>setPoint({...point,lat:Number(e.target.value)})}/></label>
      <label className="field">Longitude<input name={lngName} type="number" step="any" min="-180" max="180" required value={point.lng} onChange={e=>setPoint({...point,lng:Number(e.target.value)})}/></label>
    </div>
    <button type="button" className="button" onClick={()=>{
      if(!navigator.geolocation){setMessage('Location unavailable. Select a point on the map or enter coordinates.');return;}
      setMessage('Finding your location…');
      navigator.geolocation.getCurrentPosition(p=>{setPoint({lat:p.coords.latitude,lng:p.coords.longitude});setMessage('Check the pin before saving.');},()=>setMessage('Location access denied or unavailable. Select a point on the map or enter coordinates.'),{timeout:15000,maximumAge:0});
    }}>Use my location</button>
    <p className="small" role="status">{message}</p>
  </div>;
}
