'use client';
import { useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap, LayerGroup, Marker, LeafletMouseEvent } from 'leaflet';

export type Point = { lat: number; lng: number };
type Pin = Point & { id: string; name: string };
type Props = { center?: Point; pins?: Pin[]; onPick?: (point: Point) => void; height?: number };
const fallback = { lat: 23.746, lng: 90.373 };
export default function LocationMap({ center = fallback, pins = [], onPick, height = 320 }: Props) {
  const host = useRef<HTMLDivElement>(null), map = useRef<LeafletMap | null>(null);
  const layer = useRef<LayerGroup | null>(null), pick = useRef(onPick);
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  useEffect(() => { pick.current = onPick; }, [onPick]);
  useEffect(() => {
    let cancelled = false; let observer: ResizeObserver | undefined;
    void import('leaflet').then(L => {
      if (cancelled || !host.current) return;
      const m = L.map(host.current, { scrollWheelZoom: false }).setView([fallback.lat,fallback.lng],13);
      map.current = m;
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, referrerPolicy: 'origin', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(m).on('tileerror', () => setError('Map tiles could not load. Use seller links or coordinate fields where available.'));
      layer.current = L.layerGroup().addTo(m);
      m.on('click', (event: LeafletMouseEvent) => pick.current?.({ lat: event.latlng.lat, lng: event.latlng.wrap().lng }));
      observer = new ResizeObserver(() => m.invalidateSize()); observer.observe(host.current);
      setReady(true);
    }).catch(() => setError('Map unavailable. Use the coordinate fields or seller links.'));
    return () => { cancelled = true; observer?.disconnect(); map.current?.remove(); map.current = null; layer.current = null; };
  }, []);
  const lat = center.lat, lng = center.lng, editable = !!onPick;
  useEffect(() => {
    if (!ready || !map.current || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    map.current.setView([lat,lng],map.current.getZoom());
  }, [ready,lat,lng]);
  useEffect(() => {
    let cancelled = false;
    if (!ready) return;
    void import('leaflet').then(L => {
      if (cancelled || !layer.current) return;
      layer.current.clearLayers();
      const icon = L.divIcon({ className: 'foodlane-pin', html: '<span aria-hidden="true">●</span>', iconSize: [28,28], iconAnchor: [14,14] });
      for (const pin of pins) {
        // DOM textContent prevents seller-supplied labels from becoming popup HTML.
        const link = document.createElement('a'); link.textContent = pin.name; link.href = `/sellers/${encodeURIComponent(pin.id)}`;
        L.marker([pin.lat,pin.lng], { icon, title: pin.name }).bindPopup(link).addTo(layer.current);
      }
      if (editable && Number.isFinite(lat) && Number.isFinite(lng)) {
        const marker: Marker = L.marker([lat,lng], { icon, draggable: true, title: 'Selected location: drag to move' }).addTo(layer.current);
        marker.on('dragend', () => { const p = marker.getLatLng().wrap(); pick.current?.({lat:p.lat,lng:p.lng}); });
      }
    });
    return () => { cancelled = true; };
  }, [ready,pins,lat,lng,editable]);
  return <div><div ref={host} className="location-map" style={{ height, position:'relative', zIndex:0 }} aria-label={editable ? 'Choose a location by clicking the map or dragging the pin' : 'Approved food seller locations'}/>{error && <p role="status" className="small">{error}</p>}</div>;
}

export function LocationPicker({ initial = fallback, latName = 'lat', lngName = 'lng' }: { initial?: Point; latName?: string; lngName?: string }) {
  const [point,setPoint] = useState(initial), [message,setMessage] = useState('');
  return <div className="full stack"><LocationMap center={point} onPick={setPoint}/><p className="small">Click the map or drag the pin to your selling place. Home cooks can choose a nearby pickup point.</p><div className="form-grid"><label className="field">Latitude<input name={latName} type="number" step="any" min="-90" max="90" required value={point.lat} onChange={e=>setPoint({...point,lat:Number(e.target.value)})}/></label><label className="field">Longitude<input name={lngName} type="number" step="any" min="-180" max="180" required value={point.lng} onChange={e=>setPoint({...point,lng:Number(e.target.value)})}/></label></div><button type="button" className="button" onClick={()=>{
    if(!navigator.geolocation){setMessage('Location unavailable. Select a point on the map or enter coordinates.');return;}
    setMessage('Finding your location…');
    navigator.geolocation.getCurrentPosition(p=>{setPoint({lat:p.coords.latitude,lng:p.coords.longitude});setMessage('Check the pin before saving.');},()=>setMessage('Location access denied or unavailable. Select a point on the map or enter coordinates.'),{timeout:15000,maximumAge:0});
  }}>Use my location</button><p className="small" role="status">{message}</p></div>;
}
