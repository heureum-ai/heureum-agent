// Copyright (c) 2026 Heureum AI. All rights reserved.

import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/* Fix default marker icons (Leaflet + bundler issue) */
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

/* ── Types ── */

interface Review {
  author: string;
  rating?: number;
  text: string;
  time: string;
}

interface Place {
  name: string;
  address: string;
  rating?: number;
  review_count?: number;
  maps_url?: string;
  lat?: number;
  lon?: number;
  reviews?: Review[];
  price_level?: string;
  opening_hours?: string[];
  website?: string;
  editorial_summary?: string;
}

interface PlacesData {
  query: string;
  results: Place[];
}

/* ── Invalidate size + fit bounds on mount ── */

function MapSetup({ places }: { places: Place[] }) {
  const map = useMap();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    // Leaflet calculates wrong size in flex/lazy containers — force recalc
    const timer = setTimeout(() => {
      map.invalidateSize();
      const valid = places.filter((p) => p.lat != null && p.lon != null);
      if (valid.length > 0) {
        const bounds = L.latLngBounds(valid.map((p) => [p.lat!, p.lon!]));
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
      }
      done.current = true;
    }, 100);
    return () => clearTimeout(timer);
  }, [map, places]);

  return null;
}

/* ── Main component ── */

export default function PlacesMapResult({ output }: { output: string }) {
  let data: PlacesData;
  try {
    data = JSON.parse(output);
  } catch {
    return <pre className="ac-tool-output">{output}</pre>;
  }

  const places = (data.results ?? []).filter(
    (p): p is Place & { lat: number; lon: number } => p.lat != null && p.lon != null,
  );

  if (places.length === 0) {
    return <pre className="ac-tool-output">{output}</pre>;
  }

  const center: [number, number] = [places[0].lat, places[0].lon];

  return (
    <div className="ac-tool-map">
      <MapContainer center={center} zoom={13} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapSetup places={places} />
        {places.map((place, i) => (
          <Marker key={i} position={[place.lat, place.lon]}>
            <Popup maxWidth={300}>
              <strong>{place.name}</strong>
              {place.price_level && <span style={{ marginLeft: 6, fontSize: 12, color: '#666' }}>{place.price_level}</span>}
              <br />
              <span style={{ fontSize: 12 }}>{place.address}</span>
              {place.rating != null && (
                <>
                  <br />
                  <span style={{ fontSize: 12 }}>
                    ★ {place.rating}
                    {place.review_count != null && ` (${place.review_count})`}
                  </span>
                </>
              )}
              {place.editorial_summary && (
                <div style={{ fontSize: 11, color: '#555', marginTop: 4, lineHeight: 1.4, fontStyle: 'italic' }}>
                  {place.editorial_summary}
                </div>
              )}
              {place.opening_hours && place.opening_hours.length > 0 && (
                <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                  🕐 {place.opening_hours[0]}
                  {place.opening_hours.length > 1 && <span style={{ color: '#999' }}> (+{place.opening_hours.length - 1} more)</span>}
                </div>
              )}
              {place.reviews && place.reviews.length > 0 && (
                <div style={{ marginTop: 6, borderTop: '1px solid #ddd', paddingTop: 4 }}>
                  {place.reviews.map((r, ri) => (
                    <div key={ri} style={{ fontSize: 11, marginBottom: 4 }}>
                      <div>
                        <strong>{r.author}</strong>
                        {r.rating != null && <span> {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>}
                        {r.time && <span style={{ color: '#888', marginLeft: 4 }}>{r.time}</span>}
                      </div>
                      {r.text && <div style={{ color: '#444', lineHeight: 1.3 }}>{r.text.length > 100 ? r.text.slice(0, 100) + '…' : r.text}</div>}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                {place.maps_url && (
                  <a href={place.maps_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                    Google Maps
                  </a>
                )}
                {place.website && (
                  <a href={place.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                    Website
                  </a>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
