'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MapPin, Navigation, Search, Store } from 'lucide-react';
import GoogleLocationMap from './google-location-map';
import { locationLabel, googleMapsDirectionsUrl, type LocationFields } from '@/lib/location-search';
import type { PublicSeller } from '@/lib/discovery';
const emptyLocation: LocationFields = { road: '', area: '', city: '', district: '' };

export default function ExploreSellers({ directoryOnly = false }: { directoryOnly?: boolean }) {
  const [location, setLocation] = useState<LocationFields>(emptyLocation), [radius, setRadius] = useState(5);
  const [nameSearch, setNameSearch] = useState(''), [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0), [page, setPage] = useState(1);
  const [sellers, setSellers] = useState<PublicSeller[]>([]), [total, setTotal] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(true);
  const [locating, setLocating] = useState(false), [notice, setNotice] = useState('');
  const [mapPlace, setMapPlace] = useState({ query: 'Dhaka, Bangladesh', label: 'Dhaka, Bangladesh' });
  const [resultLabel, setResultLabel] = useState('All approved sellers');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/public/sellers?' + query + '&page=' + page, { signal: controller.signal });
        const data = await response.json() as { sellers: PublicSeller[]; total: number; error?: string };
        if (!response.ok) throw new Error(data.error || 'Could not load sellers.');
        if (controller.signal.aborted) return;
        setSellers(data.sellers); setTotal(data.total); setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load sellers.');
      } finally { if (!controller.signal.aborted) setBusy(false); }
    }
    void load(); return () => controller.abort();
  }, [query, page, revision]);
  function search(params: URLSearchParams, label: string) {
    setBusy(true); setSellers([]); setTotal(0); setError(''); setPage(1);
    setQuery(params.toString()); setResultLabel(label); setRevision(value => value + 1);
  }
  function searchAddress() {
    const address = locationLabel(location);
    if (!address) { setNotice('Enter a neighborhood, city or district to find sellers.'); return; }
    search(new URLSearchParams({ location: address }), address);
    setMapPlace({ query: address + ', Bangladesh', label: address });
    setNotice('Showing sellers whose published serving address matches this location.');
  }
  function showAll() {
    setLocation(emptyLocation); setNameSearch(''); setNotice('');
    setMapPlace({ query: 'Bangladesh', label: 'Bangladesh' });
    search(new URLSearchParams(), 'All approved sellers');
  }
  function nearMe() {
    if (!navigator.geolocation) { setNotice('Location access is unavailable. Search by neighborhood, city or district instead.'); return; }
    setLocating(true); setNotice('Finding your location...');
    navigator.geolocation.getCurrentPosition(position => {
      const lat = position.coords.latitude, lng = position.coords.longitude;
      setMapPlace({ query: lat + ',' + lng, label: 'Your current location' });
      search(new URLSearchParams({ lat: String(lat), lng: String(lng), radius: String(radius) }), 'Within ' + radius + ' km of you');
      setNotice('Nearby sellers are sorted by distance from your current location.'); setLocating(false);
    }, () => {
      setNotice('Location access was denied or is unavailable. Enter your neighborhood, city or district instead.');
      setLocating(false);
    }, { timeout: 15000, maximumAge: 60000 });
  }
  return <>
    <p className="intro">{directoryOnly ? 'Find other approved Foodlane sellers and visit their public profiles.' :
      'Find local food by road, neighborhood, city or district. Choose a seller to see their serving location on Google Maps.'}</p>
    {directoryOnly ? <form className="seller-search" onSubmit={event => {
      event.preventDefault(); search(new URLSearchParams(nameSearch.trim() ? { search: nameSearch.trim() } : {}), 'Seller search');
    }}>
      <label className="field" htmlFor="seller-directory-search">Search seller name or neighborhood</label>
      <div className="seller-search-row"><input id="seller-directory-search" value={nameSearch} maxLength={80}
        onChange={event => setNameSearch(event.target.value)} placeholder="e.g. Nini's Kitchen or Gulshan"/>
        <button className="button primary">Search</button><button type="button" className="button" onClick={showAll}>Show all</button>
      </div>
    </form> : <>
      <form className="address-search-panel" aria-label="Search sellers by location" onSubmit={event => { event.preventDefault(); searchAddress(); }}>
        <div className="address-search-heading"><MapPin size={23}/><div><h2>Where shall we eat?</h2><p>A familiar place. A new favorite.</p></div></div>
        <div className="address-search-fields">
          <label className="field"><span>Road, house or landmark <span className="field-optional">Optional</span></span>
            <input value={location.road} maxLength={140} onChange={event => setLocation(value => ({ ...value, road: event.target.value }))}
              placeholder="e.g. Road 12 or Gulshan DCC Market" autoComplete="address-line1"/>
          </label>
          <label className="field">Area / neighborhood
            <input value={location.area} maxLength={80} onChange={event => setLocation(value => ({ ...value, area: event.target.value }))}
              placeholder="e.g. Gulshan 1" autoComplete="address-line2"/>
          </label>
          <label className="field">City
            <input value={location.city} maxLength={80} onChange={event => setLocation(value => ({ ...value, city: event.target.value }))}
              placeholder="e.g. Dhaka" autoComplete="address-level2"/>
          </label>
          <label className="field">District
            <input value={location.district} maxLength={80} onChange={event => setLocation(value => ({ ...value, district: event.target.value }))}
              placeholder="e.g. Dhaka" autoComplete="address-level1"/>
          </label>
        </div>
        <div className="address-search-actions">
          <button className="button primary"><Search size={16}/>Find food here</button>
          <button type="button" className="button" disabled={locating} onClick={nearMe}><Navigation size={16}/>{locating ? 'Finding you...' : 'Near me'}</button>
          <label className="nearby-distance">Near-me distance
            <select value={radius} onChange={event => setRadius(Number(event.target.value))}>
              {[1,3,5,10,20,50,100].map(value => <option key={value} value={value}>{value} km</option>)}
            </select>
          </label>
          <button type="button" className="address-show-all" onClick={showAll}>All approved sellers</button>
        </div>
        <p className="address-search-hint">Search as broadly as a district, or add a road to narrow it down. Distance applies to Near me.</p>
      </form>
      <p className="location-search-notice" role="status">{notice}</p>
      <GoogleLocationMap query={mapPlace.query} label={mapPlace.label}/>
    </>}
    {error && <p role="alert" className="status-message">{error} <button onClick={() => { setBusy(true); setRevision(value => value + 1); }}>Try again</button></p>}
    <div className="location-results-heading"><div><span className="eyebrow">{directoryOnly ? 'MEET LOCAL SELLERS' : resultLabel}</span>
      <h2>{busy ? 'Finding sellers...' : total + ' approved ' + (total === 1 ? 'seller' : 'sellers')}</h2></div>
    </div>
    <div className="seller-directory">{sellers.map(seller => <article className="panel location-seller-card" key={seller.id}>
      <div className="location-seller-heading"><Store size={19}/><h3><Link href={'/sellers/' + encodeURIComponent(seller.id)}>{seller.name}</Link></h3><span className="badge">Verified</span></div>
      <p className="location-seller-address"><MapPin size={14}/>{seller.place_label}</p><p>{seller.bio}</p>
      <p className="small">{seller.distance_km !== undefined && seller.distance_km.toFixed(2) + ' km away \u00b7 '}
        {seller.review_count ? Number(seller.rating).toFixed(1) + ' / 5 \u00b7 ' + seller.review_count + ' reviews' : 'No reviews yet'}</p>
      <div className="location-seller-actions"><Link className="button primary" href={'/sellers/' + encodeURIComponent(seller.id)}>View seller & food</Link>
        {!directoryOnly && <button type="button" className="button" onClick={() => {
          setMapPlace({ query: seller.lat + ',' + seller.lng, label: seller.name + ' \u00b7 ' + seller.place_label });
          document.querySelector('.google-location-map')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}>Show on map</button>}
        <a className="button" href={googleMapsDirectionsUrl(seller.lat, seller.lng)} target="_blank" rel="noreferrer">Directions</a>
      </div>
    </article>)}</div>
    {!busy && !total && !error && <p className="shelf-empty">No approved sellers match this location yet. Try a nearby neighborhood, search by city or district, or view all sellers.</p>}
    <div className="seller-pages"><button className="button" disabled={busy || page === 1} onClick={() => { setBusy(true); setPage(value => value - 1); }}>Previous</button>
      <span>Page {page}</span><button className="button" disabled={busy || page * 20 >= total} onClick={() => { setBusy(true); setPage(value => value + 1); }}>Next</button>
    </div>
  </>;
}
