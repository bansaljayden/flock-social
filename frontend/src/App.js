import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  calculateSubscriptionRevenue,
  calculateTransactionRevenue,
  calculateTotalMonthlyRevenue,
  calculateAnnualRevenue,
  calculateMonthlyProfit,
  calculateRevenuePerVenue,
  calculateBreakEven,
  formatCurrency,
  calculateProfitMargin
} from './lib/finance';
import { getCurrentUser, logout, isLoggedIn, getFlocks, getFlock, createFlock as apiCreateFlock, getMessages, sendMessage as apiSendMessage, updateProfile, searchVenues, searchUsers, getSuggestedUsers, sendFriendRequest, getStories, getVenueDetails, leaveFlock as apiLeaveFlock, getDMConversations, getDMs, getDmVenueVotes, getDmPinnedVenue, BASE_URL, inviteToFlock, acceptFlockInvite, declineFlockInvite, getFriends, acceptFriendRequest, declineFriendRequest, getPendingRequests, getOutgoingRequests, getFriendSuggestions, getMyFriendCode, addFriendByCode, findFriendsByPhone, removeFriend, getTrustedContacts, addTrustedContact, updateTrustedContact, deleteTrustedContact, sendEmergencyAlert, shareLocationWithContacts } from './services/api';
import { connectSocket, disconnectSocket, getSocket, joinFlock, leaveFlock, sendMessage as socketSendMessage, sendImageMessage as socketSendImage, startTyping, stopTyping, onNewMessage, onUserTyping, onUserStoppedTyping, emitLocation, stopSharingLocation as socketStopSharing, onLocationUpdate, onMemberStoppedSharing, socketSendDm, onNewDm, dmStartTyping, dmStopTyping, onDmUserTyping, onDmUserStoppedTyping, dmReact, dmRemoveReact, onDmReactionAdded, onDmReactionRemoved, dmVoteVenue, onDmNewVote, dmShareLocation, dmStopSharingLocation, onDmLocationUpdate, onDmMemberStoppedSharing, dmPinVenue, onDmVenuePinned, emitFlockInvite, emitFlockInviteResponse, onFlockInviteReceived, onFlockInviteResponded, emitFriendRequest, emitFriendResponse, onFriendRequestReceived, onFriendRequestResponded } from './services/socket';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode } from 'html5-qrcode';
import LoginScreen from './components/auth/LoginScreen';
import SignupScreen from './components/auth/SignupScreen';
import { MarkerClusterer } from '@googlemaps/markerclusterer';

// Load Google Maps dynamically from .env — API key never exposed in HTML
const loadGoogleMapsScript = () => {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[src*="maps.googleapis.com"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      if (window.google?.maps) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.REACT_APP_GOOGLE_MAPS_API_KEY}&libraries=places,visualization`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
};

// Memoized VenueCard — unified design for both DMs and Flocks
const VenueCard = React.memo(({ venue, onViewDetails, onVote, colors: c, Icons: I, getCategoryColor: gcc }) => {
  const rating = venue.stars || venue.rating || null;
  const price = venue.price || (venue.price_level ? '$'.repeat(venue.price_level) : null);
  const address = venue.addr || venue.formatted_address || '';
  const crowd = typeof venue.crowd === 'number' ? venue.crowd : Math.round(20 + ((((venue.place_id || venue.name || '').charCodeAt(0) || 0) * 37) % 60));
  const crowdColor = crowd > 70 ? '#EF4444' : crowd > 40 ? '#F59E0B' : '#22C55E';
  return (
    <div style={{
      backgroundColor: 'white',
      borderRadius: '16px',
      overflow: 'hidden',
      boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
      border: '1px solid rgba(0,0,0,0.06)',
      width: '100%',
      maxWidth: '280px',
      animation: 'cardSlideIn 0.4s ease-out'
    }}>
      {venue.photo_url && (
        <img src={venue.photo_url} alt={venue.name} style={{ width: '100%', height: '160px', objectFit: 'cover', display: 'block' }} onError={(e) => { e.target.style.display = 'none'; }} />
      )}

      <div style={{ padding: '14px' }}>
        <h4 style={{ fontSize: '15px', fontWeight: '700', color: c.navy, margin: '0 0 4px' }}>{venue.name}</h4>

        {address && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
            {I.mapPin('#6b7280', 12)}
            <span style={{ fontSize: '11px', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
          {price && <span style={{ fontSize: '12px', color: c.navy, fontWeight: '600' }}>{price}</span>}
          {rating && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              {I.starFilled('#fbbf24', 12)}
              <span style={{ fontSize: '12px', color: c.navy, fontWeight: '600' }}>{rating}</span>
            </div>
          )}
        </div>

        <div style={{ backgroundColor: '#f8fafc', borderRadius: '12px', padding: '10px 12px', marginBottom: '12px', border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', color: '#64748b', fontWeight: '500' }}>Current Crowd</span>
            <div style={{ backgroundColor: `${crowdColor}20`, color: crowdColor, padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '700' }}>{crowd}%</div>
          </div>
          <div style={{ width: '100%', height: '6px', backgroundColor: '#e2e8f0', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${crowd}%`, backgroundColor: crowdColor, borderRadius: '3px', transition: 'width 0.5s ease-out' }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          {(venue.place_id || venue.id) && (
            <button onClick={onViewDetails} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `2px solid ${c.navy}`, backgroundColor: 'white', color: c.navy, fontSize: '12px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', transition: 'all 0.2s ease' }}>
              {I.eye(c.navy, 14)} View Details
            </button>
          )}
          <button onClick={(e) => { const btn = e.currentTarget; if (!btn.classList.contains('btn-confirmed')) { btn.classList.add('btn-confirmed'); setTimeout(() => btn.classList.remove('btn-confirmed'), 1100); } onVote(); }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: `linear-gradient(135deg, ${c.navy}, ${c.navyMid})`, color: 'white', fontSize: '12px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', boxShadow: '0 2px 8px rgba(13,40,71,0.25)', transition: 'all 0.2s ease', position: 'relative', overflow: 'hidden' }}>
              {I.vote('white', 14)} Vote for This
            </button>
        </div>
      </div>
    </div>
  );
});

// Google Maps dark theme matching Flock's navy aesthetic
const FLOCK_MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#1a2a3a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a2a3a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#b8d4e3' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6b8a9e' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1e3a2a' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#4a8c6f' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2d4a5c' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1a3045' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a5a70' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f3a4f' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#b8c8d8' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2a3a4a' }] },
  { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#7a9ab0' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1f30' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#3a6080' }] },
];

// Google Maps wrapper — Flock-branded pins + AI crowd heatmap
const GoogleMapView = React.memo(({ venues, filterCategory, userLocation, activeVenue, setActiveVenue, getCategoryColor, pickingVenueForCreate, setPickingVenueForCreate, setSelectedVenueForCreate, setCurrentScreen, openVenueDetail, flockMemberLocations, calcDistance }) => {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]); // each entry: { marker, venue }
  const clustererRef = useRef(null);
  const heatmapRef = useRef(null);
  const userMarkerRef = useRef(null);
  const memberMarkersRef = useRef({}); // userId -> { marker, infoWindow }
  const prevVenueCountRef = useRef(0); // track if venues are newly loaded vs just re-rendered
  const [mapReady, setMapReady] = useState(false); // tracks when Google Map instance is initialized
  const [mapType, setMapType] = useState(() => localStorage.getItem('flock_map_type') || 'roadmap');

  const toggleMapType = useCallback(() => {
    const newType = mapType === 'roadmap' ? 'hybrid' : 'roadmap';
    setMapType(newType);
    localStorage.setItem('flock_map_type', newType);
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setMapTypeId(newType);
      // Apply custom styles only on roadmap, satellite looks better without them
      mapInstanceRef.current.setOptions({ styles: newType === 'roadmap' ? FLOCK_MAP_STYLES : [] });
    }
  }, [mapType]);

  const DEFAULT_ZOOM = 12;

  // Get user's REAL location — works anywhere (PA, KY, CA, anywhere!)
  // Only falls back to Hellertown if geolocation is denied/unsupported
  const getUserLocation = () => {
    return new Promise((resolve) => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const userLoc = {
              lat: position.coords.latitude,
              lng: position.coords.longitude
            };
            console.log('[Map] User location:', userLoc);
            resolve(userLoc);
          },
          (error) => {
            console.log('[Map] Geolocation denied/failed:', error.message, '- using Hellertown fallback');
            resolve({ lat: 40.5798, lng: -75.2932 });
          },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
      } else {
        console.log('[Map] Geolocation not supported - using Hellertown fallback');
        resolve({ lat: 40.5798, lng: -75.2932 });
      }
    });
  };

  // Build Flock-branded pin SVG
  const buildPinSvg = useCallback((isActive, category) => {
    const fill = isActive ? '#14B8A6' : '#0d2847';
    const stroke = '#f5f0e6';
    const size = isActive ? 44 : 32;
    const iconMap = { Food: '🍕', Nightlife: '🍸', 'Live Music': '🎵', Sports: '⚽' };
    const emoji = iconMap[category] || '📍';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 1.32)}" viewBox="0 0 32 42">` +
      `<defs><filter id="s" x="-20%" y="-10%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/></filter></defs>` +
      `<path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z" fill="${fill}" stroke="${stroke}" stroke-width="2" filter="url(#s)"/>` +
      `<circle cx="16" cy="14.5" r="9" fill="white"/>` +
      `<text x="16" y="18.5" text-anchor="middle" font-size="12">${emoji}</text>` +
      `</svg>`;
  }, []);

  // Crowd color helper — used by map popup & venue cards
  const getCrowdColor = (crowd) => crowd > 70 ? '#EF4444' : crowd > 40 ? '#F59E0B' : '#10B981'; // eslint-disable-line no-unused-vars

  // Initialize map ONCE — load Google Maps script, get user location, then create map
  useEffect(() => {
    if (!mapRef.current) return;
    if (mapInstanceRef.current) return;

    const initMap = async () => {
      // Load Google Maps script first (from .env, not index.html)
      await loadGoogleMapsScript();

      // Get user's REAL location (wherever they are!)
      const userLoc = await getUserLocation();

      console.log('[Map] Initializing map at:', userLoc);

      // Create map centered on THEIR location
      const savedMapType = localStorage.getItem('flock_map_type') || 'roadmap';
      const map = new window.google.maps.Map(mapRef.current, {
        center: userLoc,
        zoom: DEFAULT_ZOOM,
        minZoom: 3,
        maxZoom: 18,
        styles: savedMapType === 'roadmap' ? FLOCK_MAP_STYLES : [],
        mapTypeId: savedMapType,
        disableDefaultUI: true,
        zoomControl: false,
        fullscreenControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        gestureHandling: 'greedy',
      });
      mapInstanceRef.current = map;
      setMapReady(true);
      map.addListener('click', () => { setActiveVenue(null); });

      console.log('[Map] Map created, centered on user at', userLoc.lat, userLoc.lng);

      // Listen for permission changes (denied → granted)
      if (navigator.permissions) {
        navigator.permissions.query({ name: 'geolocation' }).then((permStatus) => {
          permStatus.addEventListener('change', () => {
            if (permStatus.state === 'granted') {
              navigator.geolocation.getCurrentPosition(
                (pos) => {
                  const newLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                  console.log('[Map] Permission changed to granted, re-centering:', newLoc);
                  map.panTo(newLoc);
                  map.setZoom(DEFAULT_ZOOM);
                },
                () => {},
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
              );
            }
          });
        }).catch(() => {});
      }
    };

    initMap();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // User location blue dot with accuracy circle + live tracking
  const accuracyCircleRef = useRef(null);
  const watchIdRef = useRef(null);

  useEffect(() => {
    if (!mapReady || !mapInstanceRef.current || !userLocation) return;
    const pos = { lat: userLocation.lat, lng: userLocation.lng };
    if (userMarkerRef.current) {
      userMarkerRef.current.setPosition(pos);
    } else {
      userMarkerRef.current = new window.google.maps.Marker({
        position: pos,
        map: mapInstanceRef.current,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#3b82f6',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
        zIndex: 999,
        title: 'You are here',
      });
    }

    // Accuracy circle
    const accuracy = userLocation.accuracy || 50;
    if (accuracyCircleRef.current) {
      accuracyCircleRef.current.setCenter(pos);
      accuracyCircleRef.current.setRadius(accuracy);
    } else {
      accuracyCircleRef.current = new window.google.maps.Circle({
        map: mapInstanceRef.current,
        center: pos,
        radius: accuracy,
        fillColor: '#3b82f6',
        fillOpacity: 0.1,
        strokeColor: '#3b82f6',
        strokeOpacity: 0.3,
        strokeWeight: 1,
        clickable: false,
        zIndex: 998,
      });
    }
  }, [userLocation, mapReady]);

  // Live position tracking — update blue dot every 10 seconds
  useEffect(() => {
    if (!mapReady || !navigator.geolocation) return;
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const newLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        if (userMarkerRef.current) userMarkerRef.current.setPosition({ lat: newLoc.lat, lng: newLoc.lng });
        if (accuracyCircleRef.current) {
          accuracyCircleRef.current.setCenter({ lat: newLoc.lat, lng: newLoc.lng });
          accuracyCircleRef.current.setRadius(newLoc.accuracy || 50);
        }
      },
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); };
  }, [mapReady]);

  // Venue markers + heatmap — rebuild ONLY when venue data actually changes (not on activeVenue!)
  useEffect(() => {
    if (!mapInstanceRef.current || !window.google?.maps) return;

    // Clear previous markers + clusterer + heatmap
    if (clustererRef.current) {
      clustererRef.current.clearMarkers();
      clustererRef.current = null;
    }
    if (heatmapRef.current) {
      heatmapRef.current.setMap(null);
      heatmapRef.current = null;
    }
    markersRef.current.forEach(entry => {
      entry.marker.setMap(null);
    });
    markersRef.current = [];

    const bounds = new window.google.maps.LatLngBounds();
    prevVenueCountRef.current = venues.length;
    const allMarkers = [];
    const heatPoints = [];

    venues.forEach(v => {
      const loc = v.location;
      if (!loc || !loc.latitude || !loc.longitude) return;

      const position = { lat: loc.latitude, lng: loc.longitude };

      // Collect heatmap data points weighted by crowd level
      if (typeof v.crowd === 'number') {
        heatPoints.push({ lat: loc.latitude, lng: loc.longitude, weight: v.crowd / 100 });
      }

      // --- Custom Flock pin (don't add to map yet — clusterer manages it) ---
      const pinSvg = buildPinSvg(false, v.category);
      const pinSize = 32;
      const pinHeight = Math.round(pinSize * 1.32);

      const marker = new window.google.maps.Marker({
        position,
        title: v.name,
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(pinSvg),
          scaledSize: new window.google.maps.Size(pinSize, pinHeight),
          anchor: new window.google.maps.Point(pinSize / 2, pinHeight),
        },
        zIndex: v.trending ? 50 : 10,
      });

      marker.addListener('mouseover', () => {
        marker.setAnimation(window.google.maps.Animation.BOUNCE);
        setTimeout(() => marker.setAnimation(null), 750);
      });

      marker.addListener('click', () => {
        setActiveVenue(v);
        mapInstanceRef.current.panTo(position);
      });

      markersRef.current.push({ marker, venue: v });
      allMarkers.push(marker);
      bounds.extend(position);
    });

    // Heatmap overlay — Google HeatmapLayer
    if (heatPoints.length > 0 && window.google.maps.visualization) {
      const heatData = heatPoints.map(pt => ({
        location: new window.google.maps.LatLng(pt.lat, pt.lng),
        weight: pt.weight,
      }));
      heatmapRef.current = new window.google.maps.visualization.HeatmapLayer({
        data: heatData,
        map: mapInstanceRef.current,
        radius: 50,
        opacity: 0.8,
        dissipating: true,
        maxIntensity: 1,
        gradient: [
          'rgba(0, 0, 0, 0)',
          'rgba(10, 120, 50, 0.55)',
          'rgba(14, 140, 58, 0.72)',
          'rgba(60, 155, 30, 0.8)',
          'rgba(200, 140, 0, 0.84)',
          'rgba(220, 110, 0, 0.88)',
          'rgba(200, 45, 45, 0.92)',
          'rgba(180, 20, 20, 0.96)',
        ],
      });
    }

    // Create clusterer — groups overlapping pins into numbered clusters
    if (allMarkers.length > 0) {
      clustererRef.current = new MarkerClusterer({
        map: mapInstanceRef.current,
        markers: allMarkers,
        renderer: {
          render: ({ count, position }) => {
            return new window.google.maps.Marker({
              position,
              label: { text: String(count), color: 'white', fontSize: '12px', fontWeight: '700' },
              icon: {
                path: window.google.maps.SymbolPath.CIRCLE,
                scale: 20,
                fillColor: '#0d2847',
                fillOpacity: 0.9,
                strokeColor: '#f5f0e6',
                strokeWeight: 2,
              },
              zIndex: 1000,
            });
          },
        },
      });
    }
  }, [venues, buildPinSvg]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only rebuild markers when venue DATA changes — setters are stable refs, don't trigger rebuilds

  // Active venue highlight — update pin style WITHOUT rebuilding everything
  useEffect(() => {
    markersRef.current.forEach(entry => {
      const isActive = activeVenue?.id === entry.venue.id;
      const pinSvg = buildPinSvg(isActive, entry.venue.category);
      const pinSize = isActive ? 44 : 32;
      const pinHeight = Math.round(pinSize * 1.32);
      entry.marker.setIcon({
        url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(pinSvg),
        scaledSize: new window.google.maps.Size(pinSize, pinHeight),
        anchor: new window.google.maps.Point(pinSize / 2, pinHeight),
      });
      entry.marker.setZIndex(isActive ? 100 : entry.venue.trending ? 50 : 10);
    });
  }, [activeVenue, buildPinSvg]);

  // Filter visibility — show/hide markers by category WITHOUT moving the map
  // Uses actual Google Places types for broader, more accurate matching
  useEffect(() => {
    markersRef.current.forEach(entry => {
      const v = entry.venue;
      const t = (v.types || []).join(' ').toLowerCase();
      const nm = (v.name || '').toLowerCase();
      let show = true;
      if (filterCategory && filterCategory !== 'All') {
        if (filterCategory === 'Food') {
          show = t.includes('restaurant') || t.includes('cafe') || t.includes('food') || t.includes('bakery') || t.includes('meal') || t.includes('pizza') || t.includes('diner') || t.includes('bar') || v.category === 'Food';
        } else if (filterCategory === 'Nightlife') {
          show = t.includes('bar') || t.includes('night_club') || t.includes('club') || t.includes('liquor') || t.includes('lounge') || v.category === 'Nightlife';
        } else if (filterCategory === 'Live Music') {
          show = t.includes('music') || t.includes('concert') || t.includes('performing_arts') || nm.includes('music') || nm.includes('jazz') || v.category === 'Live Music';
        } else if (filterCategory === 'Sports') {
          show = t.includes('stadium') || t.includes('gym') || t.includes('sports') || t.includes('bowling') || t.includes('fitness') || nm.includes('sport') || v.category === 'Sports';
        }
      }
      entry.marker.setVisible(show);
    });
  }, [filterCategory]);

  // Expose global helpers for external venue navigation
  useEffect(() => {
    window.__flockOpenVenue = (placeId) => {
      const v = venues.find(venue => venue.place_id === placeId);
      if (v) openVenueDetail(placeId, { name: v.name, formatted_address: v.addr, place_id: placeId, rating: v.stars, photo_url: v.photo_url });
    };
    // Pan to a specific venue from outside (chat, search, etc.)
    // Accepts placeId string OR object { place_id, lat, lng } for coordinate-based fallback
    window.__flockPanToVenue = (target) => {
      if (!mapInstanceRef.current) return;
      const placeId = typeof target === 'string' ? target : target?.place_id;
      const fallbackLat = typeof target === 'object' ? parseFloat(target?.lat) : NaN;
      const fallbackLng = typeof target === 'object' ? parseFloat(target?.lng) : NaN;

      // Try to find existing marker by place_id
      const entry = placeId ? markersRef.current.find(e => e.venue.place_id === placeId) : null;
      if (entry) {
        const loc = entry.venue.location;
        mapInstanceRef.current.panTo({ lat: loc.latitude, lng: loc.longitude });
        mapInstanceRef.current.setZoom(17);
        setActiveVenue(entry.venue);
        entry.marker.setAnimation(window.google.maps.Animation.BOUNCE);
        setTimeout(() => entry.marker.setAnimation(null), 1500);
      } else if (!isNaN(fallbackLat) && !isNaN(fallbackLng)) {
        // Fallback: use raw coordinates (venue not in current markers)
        mapInstanceRef.current.panTo({ lat: fallbackLat, lng: fallbackLng });
        mapInstanceRef.current.setZoom(17);
        // Try to find by proximity (within ~100m)
        const nearby = markersRef.current.find(e => {
          const loc = e.venue.location;
          if (!loc) return false;
          const dist = Math.sqrt(Math.pow(loc.latitude - fallbackLat, 2) + Math.pow(loc.longitude - fallbackLng, 2)) * 111000;
          return dist < 100;
        });
        if (nearby) {
          setActiveVenue(nearby.venue);
          nearby.marker.setAnimation(window.google.maps.Animation.BOUNCE);
          setTimeout(() => nearby.marker.setAnimation(null), 1500);
        } else {
          // No existing marker — create a temporary pin at these coordinates
          const venueName = target?.name || 'Venue';
          const venueAddr = target?.address || '';
          const venueRating = target?.rating ? parseFloat(target.rating) : 4.0;
          const venuePhoto = target?.photo_url || null;
          const seed = ((placeId || venueName || '').charCodeAt(0) || 0) + Math.floor(fallbackLat * 100);
          const crowd = Math.round(20 + ((seed * 37) % 70));
          const bestTimes = ['6-8 PM', '7-9 PM', '8-10 PM', '5-7 PM', '9-11 PM'];

          const tempPinSvg = buildPinSvg(true, 'Food');
          const tempPinSize = 44;
          const tempPinHeight = Math.round(tempPinSize * 1.32);

          // Create a complete venue object with all fields the info card needs
          const tempVenue = {
            id: 'temp_nav_' + Date.now(),
            place_id: placeId || null,
            name: venueName,
            addr: venueAddr,
            type: 'Venue',
            category: 'Food',
            price: '$$',
            stars: venueRating,
            crowd: crowd,
            best: bestTimes[seed % bestTimes.length],
            trending: false,
            photo_url: venuePhoto,
            location: { latitude: fallbackLat, longitude: fallbackLng },
            types: [],
          };

          const tempMarker = new window.google.maps.Marker({
            position: { lat: fallbackLat, lng: fallbackLng },
            map: mapInstanceRef.current,
            title: venueName,
            icon: {
              url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(tempPinSvg),
              scaledSize: new window.google.maps.Size(tempPinSize, tempPinHeight),
              anchor: new window.google.maps.Point(tempPinSize / 2, tempPinHeight),
            },
            animation: window.google.maps.Animation.DROP,
            zIndex: 200,
          });

          // Click listener so pin is re-clickable
          tempMarker.addListener('click', () => {
            setActiveVenue(tempVenue);
            mapInstanceRef.current.panTo({ lat: fallbackLat, lng: fallbackLng });
          });

          setTimeout(() => {
            tempMarker.setAnimation(window.google.maps.Animation.BOUNCE);
            setTimeout(() => tempMarker.setAnimation(null), 1500);
          }, 400);

          markersRef.current.push({ marker: tempMarker, venue: tempVenue });
          setActiveVenue(tempVenue);

          // Auto-open venue detail if we have a place_id
          if (placeId) {
            openVenueDetail(placeId, { name: venueName, formatted_address: venueAddr, place_id: placeId, rating: venueRating, photo_url: venuePhoto });
          }
        }
      }
    };
    // My Location: instantly pan to the blue dot (no GPS request needed — just go to where the dot already is)
    window.__flockGoToMyLocation = () => {
      if (!mapInstanceRef.current) return;

      // If we have a blue dot, just pan to it instantly
      if (userMarkerRef.current) {
        const pos = userMarkerRef.current.getPosition();
        mapInstanceRef.current.panTo(pos);
        mapInstanceRef.current.setZoom(15);

        // Pulse animation on blue dot so user sees it
        const pulseScales = [14, 16, 14, 12, 10];
        pulseScales.forEach((s, i) => {
          setTimeout(() => {
            if (userMarkerRef.current) {
              userMarkerRef.current.setIcon({
                path: window.google.maps.SymbolPath.CIRCLE,
                scale: s,
                fillColor: '#3b82f6',
                fillOpacity: i < 2 ? 0.7 : 1,
                strokeColor: '#ffffff',
                strokeWeight: 3,
              });
            }
          }, i * 400);
        });
        return;
      }

      // No blue dot yet — fall back to map center
      const center = mapInstanceRef.current.getCenter();
      if (center) {
        mapInstanceRef.current.panTo(center);
        mapInstanceRef.current.setZoom(15);
      }
    };
    return () => { delete window.__flockOpenVenue; delete window.__flockPanToVenue; delete window.__flockGoToMyLocation; };
  }, [venues, openVenueDetail, setActiveVenue, buildPinSvg]);

  // Render flock member location markers
  useEffect(() => {
    if (!mapReady || !mapInstanceRef.current || !flockMemberLocations) return;
    const map = mapInstanceRef.current;
    const currentIds = new Set(Object.keys(flockMemberLocations));

    // Remove markers for members who stopped sharing
    Object.keys(memberMarkersRef.current).forEach(uid => {
      if (!currentIds.has(uid)) {
        memberMarkersRef.current[uid].marker.setMap(null);
        memberMarkersRef.current[uid].infoWindow.close();
        delete memberMarkersRef.current[uid];
      }
    });

    // Add/update markers for sharing members
    Object.entries(flockMemberLocations).forEach(([uid, loc]) => {
      const pos = { lat: loc.lat, lng: loc.lng };
      const dist = userLocation ? calcDistance(userLocation.lat, userLocation.lng, loc.lat, loc.lng) : '';
      const age = Math.round((Date.now() - loc.timestamp) / 1000);
      const ageStr = age < 10 ? 'just now' : age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
      const initial = (loc.name || '?')[0].toUpperCase();
      const cardHtml = `<div style="font-family:-apple-system,system-ui,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;gap:10px;padding:6px 4px;min-width:160px">
        <div style="width:36px;height:36px;border-radius:18px;background:linear-gradient(135deg,#0d2847,#1a3a5c);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 6px rgba(13,40,71,0.3)">
          <span style="color:white;font-size:15px;font-weight:700;line-height:1">${initial}</span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;color:#0d2847;margin:0 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${loc.name}</div>
          <div style="display:flex;align-items:center;gap:4px">
            <span style="width:6px;height:6px;border-radius:3px;background:#22c55e;display:inline-block;flex-shrink:0"></span>
            <span style="font-size:11px;color:#6b7280;font-weight:500">${dist ? dist + ' away' : 'Live'}${dist ? ' · ' + ageStr : ''}</span>
          </div>
        </div>
      </div>`;

      if (memberMarkersRef.current[uid]) {
        memberMarkersRef.current[uid].marker.setPosition(pos);
        memberMarkersRef.current[uid].infoWindow.setContent(cardHtml);
      } else {
        const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="18" fill="#0d2847" stroke="white" stroke-width="3"/>
          <circle cx="20" cy="20" r="18" fill="none" stroke="#22c55e" stroke-width="2" stroke-dasharray="4 4" opacity="0.6"/>
          <text x="20" y="26" text-anchor="middle" fill="white" font-size="16" font-weight="bold" font-family="system-ui">${initial}</text>
        </svg>`;
        const marker = new window.google.maps.Marker({
          position: pos,
          map,
          icon: {
            url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svgIcon),
            scaledSize: new window.google.maps.Size(40, 40),
            anchor: new window.google.maps.Point(20, 20),
          },
          zIndex: 998,
          title: loc.name,
        });
        const infoWindow = new window.google.maps.InfoWindow({ content: cardHtml });
        marker.addListener('click', () => {
          Object.values(memberMarkersRef.current).forEach(m => m.infoWindow.close());
          infoWindow.open(map, marker);
        });
        memberMarkersRef.current[uid] = { marker, infoWindow };
      }
    });
  }, [mapReady, flockMemberLocations, userLocation, calcDistance]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* Map loading overlay — shown until Google Map initializes */}
      {!mapReady && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, backgroundColor: '#1a2a3a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <div style={{ width: '32px', height: '32px', border: '3px solid rgba(255,255,255,0.15)', borderTopColor: '#14B8A6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ color: '#8ec3b9', fontSize: '13px', fontWeight: '500', margin: 0 }}>Loading map...</p>
        </div>
      )}
      {/* Minimize Google branding — legal but nearly invisible. Zoom controls always work. */}
      <style>{`
        .gm-style-cc { opacity: 0.1 !important; pointer-events: none; transition: opacity 0.3s; font-size: 7px !important; }
        .gm-style-cc:hover { opacity: 0.4 !important; pointer-events: auto; }
        .gm-style-cc a, .gm-style-cc span { font-size: 7px !important; }
        .gm-style a[href^="https://maps.google"] { opacity: 0.1 !important; transform: scale(0.7); transform-origin: bottom left; transition: opacity 0.3s; }
        .gm-style a[href^="https://maps.google"]:hover { opacity: 0.35 !important; }
        .gm-style a[title="Open this area in Google Maps (opens a new window)"] img { opacity: 0.15 !important; }
        .gm-style .gm-bundled-control { display: none !important; }
      `}</style>
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* My Location button — Snap Maps style */}
      <button
        id="flock-my-location-btn"
        onClick={() => window.__flockGoToMyLocation && window.__flockGoToMyLocation()}
        style={{
          position: 'absolute', bottom: '80px', right: '12px',
          width: '44px', height: '44px', borderRadius: '22px',
          border: 'none', background: 'white', cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 5, transition: 'transform 0.2s ease, opacity 0.3s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        title="My Location"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
        </svg>
      </button>

      {/* Zoom controls */}
      <div style={{
        position: 'absolute', bottom: '184px', right: '12px',
        display: 'flex', flexDirection: 'column',
        borderRadius: '22px', overflow: 'hidden',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)', zIndex: 5,
      }}>
        <button
          onClick={() => mapInstanceRef.current && mapInstanceRef.current.setZoom(mapInstanceRef.current.getZoom() + 1)}
          style={{
            width: '44px', height: '40px', border: 'none', background: 'white', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
          title="Zoom in"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0d2847" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <div style={{ height: '1px', background: '#e5e7eb' }} />
        <button
          onClick={() => mapInstanceRef.current && mapInstanceRef.current.setZoom(mapInstanceRef.current.getZoom() - 1)}
          style={{
            width: '44px', height: '40px', border: 'none', background: 'white', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
          title="Zoom out"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0d2847" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      {/* Satellite / Map toggle — Snapchat-style */}
      <button
        onClick={toggleMapType}
        style={{
          position: 'absolute', bottom: '132px', right: '12px',
          width: '44px', height: '44px', borderRadius: '22px',
          border: 'none', background: 'white', cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 5, transition: 'transform 0.2s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        title={mapType === 'roadmap' ? 'Switch to Satellite' : 'Switch to Map'}
      >
        {mapType === 'roadmap' ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0d2847" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0d2847" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
          </svg>
        )}
      </button>

      {/* Heatmap Legend */}
      <div style={{
        position: 'absolute',
        bottom: '12px',
        left: '10px',
        background: 'rgba(13,40,71,0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderRadius: '10px',
        padding: '8px 10px',
        zIndex: 5,
        boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
      }}>
        <div style={{ fontSize: '9px', fontWeight: '700', color: 'rgba(255,255,255,0.7)', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>AI Crowd Forecast</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10B981', boxShadow: '0 0 4px #10B981' }} />
            <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.8)', fontWeight: '500' }}>Quiet</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#F59E0B', boxShadow: '0 0 4px #F59E0B' }} />
            <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.8)', fontWeight: '500' }}>Moderate</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#EF4444', boxShadow: '0 0 4px #EF4444' }} />
            <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.8)', fontWeight: '500' }}>Busy</span>
          </div>
        </div>
      </div>
    </div>
  );
});

// Brand Colors
const colors = {
  navy: '#0d2847',
  navyLight: '#1a3a5c',
  navyMid: '#2d5a87',
  skyBlue: '#4a7ba7',
  cream: '#f5f0e6',
  creamDark: '#e8e0d0',
  teal: '#14B8A6',
  amber: '#F59E0B',
  red: '#EF4444',
  food: '#F97316',
  nightlife: '#1a3a5c',
  music: '#2d5a87',
  sports: '#22C55E',
};

// Shared styles
const styles = {
  phoneContainer: {
    width: '375px',
    maxWidth: '375px',
    height: '100vh',
    maxHeight: '812px',
    margin: '20px auto',
    borderRadius: '44px',
    border: `6px solid ${colors.navy}`,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'white',
    boxShadow: '0 25px 80px -12px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(13,40,71,0.2), inset 0 1px 0 rgba(255,255,255,0.1)',
    position: 'relative',
  },
  notch: {
    height: '28px',
    backgroundColor: colors.navy,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  notchInner: {
    width: '120px',
    height: '24px',
    backgroundColor: 'black',
    borderRadius: '20px',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  bottomNav: {
    display: 'flex',
    justifyContent: 'space-around',
    padding: '8px 4px',
    backgroundColor: 'white',
    borderTop: `1px solid ${colors.creamDark}`,
    flexShrink: 0,
  },
  navItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    padding: '6px 12px',
    borderRadius: '12px',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: 'transparent',
  },
  gradientButton: {
    background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
    color: 'white',
    border: 'none',
    borderRadius: '14px',
    padding: '14px 24px',
    fontWeight: '700',
    fontSize: '14px',
    cursor: 'pointer',
    width: '100%',
    boxShadow: '0 4px 15px rgba(13,40,71,0.3), 0 2px 4px rgba(0,0,0,0.1)',
    transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
    letterSpacing: '0.3px',
    position: 'relative',
    overflow: 'hidden',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: '18px',
    padding: '16px',
    marginBottom: '12px',
    boxShadow: '0 4px 24px rgba(13,40,71,0.08), 0 1px 3px rgba(0,0,0,0.04)',
    border: '1px solid rgba(255,255,255,0.9)',
    transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  input: {
    width: '100%',
    padding: '14px 16px',
    borderRadius: '14px',
    border: `2px solid ${colors.creamDark}`,
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
    backgroundColor: 'rgba(255,255,255,0.95)',
    fontWeight: '500',
  },
};

const FlockAppInner = ({ authUser, onLogout }) => {
  // Connect WebSocket on mount
  useEffect(() => {
    connectSocket();
    return () => disconnectSocket();
  }, []);

  // User Mode Selection
  const [userMode, setUserMode] = useState(() => localStorage.getItem('flockUserMode') || null);
  const [showModeSelection, setShowModeSelection] = useState(!localStorage.getItem('flockUserMode'));

  // Onboarding
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(() => localStorage.getItem('flockOnboardingComplete') === 'true');
  const [onboardingStep, setOnboardingStep] = useState(0);
  // onboardingName removed — name comes from signup
  const [onboardingVibes, setOnboardingVibes] = useState([]);
  const [onboardingAnimating, setOnboardingAnimating] = useState(false);

  // Navigation
  const [currentTab, setCurrentTab] = useState('home');
  const [currentScreen, setCurrentScreen] = useState('main');
  const [selectedFlockId, setSelectedFlockId] = useState(null);
  const [pickingVenueForCreate, setPickingVenueForCreate] = useState(false);
  const [pickingVenueForFlockId, setPickingVenueForFlockId] = useState(null); // existing flock ID when assigning venue
  const [selectedVenueForCreate, setSelectedVenueForCreate] = useState(null);

  // Assign a category based on Google Places types
  const categorizeVenue = useCallback((types) => {
    if (!types || types.length === 0) return 'Food';
    const t = types.join(' ').toLowerCase();
    if (t.includes('bar') || t.includes('night_club') || t.includes('liquor') || t.includes('lounge')) return 'Nightlife';
    if (t.includes('music') || t.includes('concert') || t.includes('performing_arts')) return 'Live Music';
    if (t.includes('stadium') || t.includes('gym') || t.includes('sports') || t.includes('bowling') || t.includes('fitness')) return 'Sports';
    if (t.includes('restaurant') || t.includes('cafe') || t.includes('bakery') || t.includes('food') || t.includes('pizza') || t.includes('meal')) return 'Food';
    return 'Food'; // default for libraries, parks, museums, etc.
  }, []);

  // Venue search state (hoisted from CreateScreen to avoid conditional hook calls)
  const [venueQuery, setVenueQuery] = useState('');
  const [venueResults, setVenueResults] = useState([]);
  const [venueSearching, setVenueSearching] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(true);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [searchResultsSort, setSearchResultsSort] = useState('rating');
  const searchTimerRef = useRef(null);

  // Geolocation state — restore last known location immediately so map isn't empty
  const [userLocation, setUserLocation] = useState(() => {
    const savedLat = localStorage.getItem('flock_user_lat');
    const savedLng = localStorage.getItem('flock_user_lng');
    if (savedLat && savedLng) return { lat: parseFloat(savedLat), lng: parseFloat(savedLng) };
    return null;
  });
  const [locationLoading, setLocationLoading] = useState(false);

  // Search result cache: key -> { data, timestamp }
  const searchCacheRef = useRef({});

  // Toast (hoisted above venue search for use in error handlers)
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((message, type = 'success') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }, []);

  // Confirm click — shows a ✓ overlay on the button, no state/re-renders (pure DOM + CSS)
  const confirmClick = useCallback((e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('btn-confirmed')) return;
    btn.classList.add('btn-confirmed');
    setTimeout(() => btn.classList.remove('btn-confirmed'), 1100);
  }, []);

  // Listen for toast events from Google Maps component (can't access React state directly)
  useEffect(() => {
    const handler = (e) => showToast(e.detail.message, e.detail.type);
    window.addEventListener('flock-toast', handler);
    return () => window.removeEventListener('flock-toast', handler);
  }, [showToast]);

  const enhanceQuery = useCallback((q) => {
    return q.trim();
  }, []);

  // Convert venues array to map pin format, deduplicating by place_id
  const venuesToMapPins = useCallback((venues) => {
    const seen = new Set();
    const bestTimes = ['Now-ish', 'Right now', '8 PM', '9 PM', '10 PM+', 'Sunset!', 'Game time!', '8:30ish'];
    return venues.filter(v => {
      if (seen.has(v.place_id)) return false;
      seen.add(v.place_id);
      return true;
    }).map((v, i) => {
      const seed = ((v.place_id || '').charCodeAt(0) || 0) + i;
      const crowd = Math.round(20 + ((seed * 37) % 70));
      return {
        id: i + 1,
        place_id: v.place_id,
        name: v.name,
        type: (v.types && v.types[0]) ? v.types[0].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Restaurant',
        category: categorizeVenue(v.types),
        x: 10 + ((seed * 13) % 80),
        y: 10 + ((seed * 29) % 75),
        crowd,
        best: bestTimes[i % bestTimes.length],
        stars: v.rating || 4.0,
        addr: v.formatted_address || '',
        price: v.price_level ? '$'.repeat(v.price_level) : '$$',
        trending: v.rating >= 4.5,
        photo_url: v.photo_url || null,
        location: v.location || null,
        types: v.types || [],
      };
    });
  }, [categorizeVenue]);

  const doVenueSearch = useCallback(async (q) => {
    if (!q.trim() || q.trim().length < 2) { setVenueResults([]); return; }
    const enhanced = enhanceQuery(q);
    const loc = userLocation ? `${userLocation.lat},${userLocation.lng}` : null;
    const cacheKey = `${enhanced}|${loc || ''}`;

    // Check cache (5 min TTL)
    const cached = searchCacheRef.current[cacheKey];
    if (cached && Date.now() - cached.timestamp < 300000) {
      const venues = cached.data;
      setVenueResults(venues);
      if (venues.length > 0) { setAllVenues(venuesToMapPins(venues)); setActiveVenue(null); }
      setShowSearchDropdown(true);
      return;
    }

    setVenueSearching(true);
    setShowSearchDropdown(true);
    try {
      const data = await searchVenues(enhanced, loc);
      const venues = data.venues || [];
      searchCacheRef.current[cacheKey] = { data: venues, timestamp: Date.now() };
      setVenueResults(venues);
      if (venues.length > 0) { setAllVenues(venuesToMapPins(venues)); setActiveVenue(null); }
    } catch (err) {
      console.error('Venue search error:', err);
      if (err.message && (err.message.includes('429') || err.message.toLowerCase().includes('rate') || err.message.toLowerCase().includes('too many'))) {
        showToast('Slow down! Try again in a few seconds', 'error');
      }
    } finally {
      setVenueSearching(false);
    }
  }, [enhanceQuery, venuesToMapPins, userLocation, showToast]);

  // Open the full venue details modal
  const openVenueDetail = useCallback(async (placeId, fallbackData) => {
    setVenueDetailLoading(true);
    setVenueDetailPhotoIdx(0);
    setVenueDetailModal(fallbackData ? { ...fallbackData, loading: true } : { name: 'Loading...', loading: true });
    try {
      const data = await getVenueDetails(placeId);
      console.log('[VenueDetail] API response:', JSON.stringify(data.venue, null, 2).slice(0, 500));
      setVenueDetailModal({ ...data.venue, loading: false });
    } catch (err) {
      console.error('[VenueDetail] API failed:', err.message);
      // Keep fallback data if API fails
      if (fallbackData) setVenueDetailModal({ ...fallbackData, loading: false });
      else setVenueDetailModal(null);
    } finally {
      setVenueDetailLoading(false);
    }
  }, []);

  const handleVenueQueryChange = useCallback((val) => {
    setVenueQuery(val);
    if (!showSearchResults) setShowSearchDropdown(true);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doVenueSearch(val), 400);
  }, [doVenueSearch, showSearchResults]);

  // Invite user search with debounce
  const inviteTimerRef = useRef(null);
  const handleInviteSearch = useCallback((val) => {
    setInviteSearch(val);
    if (inviteTimerRef.current) clearTimeout(inviteTimerRef.current);
    if (val.trim().length < 1) { setInviteResults([]); return; }
    setInviteSearching(true);
    inviteTimerRef.current = setTimeout(async () => {
      try {
        const data = await searchUsers(val.trim());
        setInviteResults(data.users || []);
      } catch { setInviteResults([]); }
      finally { setInviteSearching(false); }
    }, 400);
  }, []);

  // Fetch suggested users for invite section
  const loadSuggestedUsers = useCallback(async () => {
    try {
      const data = await getSuggestedUsers();
      setSuggestedUsers(data.users || []);
    } catch { /* ignore */ }
  }, []);

  // Connect panel search with debounce
  const connectTimerRef = useRef(null);
  const handleConnectSearch = useCallback((val) => {
    setConnectSearch(val);
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    if (val.trim().length < 1) { setConnectResults([]); return; }
    setConnectSearching(true);
    connectTimerRef.current = setTimeout(async () => {
      try {
        const data = await searchUsers(val.trim());
        setConnectResults(data.users || []);
      } catch { setConnectResults([]); }
      finally { setConnectSearching(false); }
    }, 400);
  }, []);

  // Add Friends screen state (declared before handlers that reference them)
  const [addFriendsTab, setAddFriendsTab] = useState('username');
  const [pendingRequests, setPendingRequests] = useState([]);
  const [outgoingRequests, setOutgoingRequests] = useState([]);
  const [friendSuggestions, setFriendSuggestions] = useState([]);
  const [addFriendsSearch, setAddFriendsSearch] = useState('');
  const [addFriendsResults, setAddFriendsResults] = useState([]);
  const [addFriendsSearching, setAddFriendsSearching] = useState(false);
  const [myFriendCode, setMyFriendCode] = useState('');
  const [friendCodeInput, setFriendCodeInput] = useState('');
  const [friendCodeLoading, setFriendCodeLoading] = useState(false);
  const [contactsUsers, setContactsUsers] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsSupported, setContactsSupported] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [qrScanError, setQrScanError] = useState('');
  const qrScannerRef = useRef(null);
  const qrScannerDivId = 'flock-qr-scanner';

  const handleSendFriendRequest = useCallback(async (user) => {
    try {
      const data = await sendFriendRequest(user.id);
      setFriendStatuses(prev => ({ ...prev, [user.id]: data.status || 'pending' }));
      emitFriendRequest(user.id);
    } catch (err) {
      showToast(err.message || 'Failed to send request', 'error');
    }
  }, [showToast]);

  // Add Friends screen handlers
  const addFriendsTimerRef = useRef(null);
  const handleAddFriendsSearch = useCallback((val) => {
    setAddFriendsSearch(val);
    if (addFriendsTimerRef.current) clearTimeout(addFriendsTimerRef.current);
    if (val.trim().length < 1) { setAddFriendsResults([]); return; }
    setAddFriendsSearching(true);
    addFriendsTimerRef.current = setTimeout(async () => {
      try {
        const data = await searchUsers(val.trim());
        setAddFriendsResults(data.users || []);
      } catch { setAddFriendsResults([]); }
      finally { setAddFriendsSearching(false); }
    }, 400);
  }, []);

  const loadAddFriendsData = useCallback(async () => {
    setContactsSupported('contacts' in navigator && 'ContactsManager' in window);
    // Generate friend code client-side (deterministic from user ID)
    if (authUser?.id) {
      setMyFriendCode('FLOCK-' + authUser.id.toString(36).toUpperCase().padStart(4, '0'));
    }
    // Load each independently so one failure doesn't block the rest
    getPendingRequests().then(d => setPendingRequests(d.requests || [])).catch(e => console.error('[AddFriends] Pending:', e.message));
    getOutgoingRequests().then(d => setOutgoingRequests(d.requests || [])).catch(e => console.error('[AddFriends] Outgoing:', e.message));
    getFriendSuggestions().then(d => setFriendSuggestions(d.suggestions || [])).catch(e => console.error('[AddFriends] Suggestions:', e.message));
  }, [authUser]);

  const handleAcceptFriendRequest = useCallback(async (userId) => {
    try {
      await acceptFriendRequest(userId);
      setPendingRequests(prev => prev.filter(r => r.id !== userId));
      setFriendStatuses(prev => ({ ...prev, [userId]: 'accepted' }));
      emitFriendResponse(userId, 'accepted');
      showToast('Friend request accepted!');
    } catch (err) {
      showToast(err.message || 'Failed to accept', 'error');
    }
  }, [showToast]);

  const handleDeclineFriendRequest = useCallback(async (userId) => {
    try {
      await declineFriendRequest(userId);
      setPendingRequests(prev => prev.filter(r => r.id !== userId));
      emitFriendResponse(userId, 'declined');
    } catch (err) {
      showToast(err.message || 'Failed to decline', 'error');
    }
  }, [showToast]);

  const handleCancelOutgoingRequest = useCallback(async (userId) => {
    try {
      await removeFriend(userId);
      setOutgoingRequests(prev => prev.filter(r => r.id !== userId));
      setFriendStatuses(prev => { const n = { ...prev }; delete n[userId]; return n; });
    } catch (err) {
      showToast(err.message || 'Failed to cancel', 'error');
    }
  }, [showToast]);

  const handleAddByCode = useCallback(async () => {
    if (!friendCodeInput.trim()) return;
    setFriendCodeLoading(true);
    try {
      const data = await addFriendByCode(friendCodeInput.trim());
      showToast(data.message);
      if (data.user) setFriendStatuses(prev => ({ ...prev, [data.user.id]: data.status || 'pending' }));
      setFriendCodeInput('');
    } catch (err) {
      showToast(err.message || 'Invalid code', 'error');
    } finally {
      setFriendCodeLoading(false);
    }
  }, [friendCodeInput, showToast]);

  const handleSyncContacts = useCallback(async () => {
    if (!('contacts' in navigator)) {
      showToast('Contact sync not supported in this browser', 'error');
      return;
    }
    setContactsLoading(true);
    try {
      const contacts = await navigator.contacts.select(['tel'], { multiple: true });
      const phones = contacts.flatMap(c => c.tel || []).filter(Boolean);
      if (phones.length === 0) {
        showToast('No phone numbers found in selected contacts');
        setContactsLoading(false);
        return;
      }
      const data = await findFriendsByPhone(phones);
      setContactsUsers(data.users || []);
      if ((data.users || []).length === 0) showToast('No Flock users found from your contacts');
    } catch (err) {
      if (err.name !== 'TypeError') showToast(err.message || 'Failed to sync contacts', 'error');
    } finally {
      setContactsLoading(false);
    }
  }, [showToast]);

  const startQrScanner = useCallback(async () => {
    setShowQrScanner(true);
    setQrScanError('');
    // Small delay to let the DOM render the scanner div
    setTimeout(async () => {
      try {
        const scanner = new Html5Qrcode(qrScannerDivId);
        qrScannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          async (decodedText) => {
            // Successfully scanned
            console.log('[QR Scan] Raw:', decodedText);
            try {
              const parsed = JSON.parse(decodedText);
              if (parsed.type === 'flock_friend' && parsed.code) {
                // Stop scanner first
                try { await scanner.stop(); } catch {}
                qrScannerRef.current = null;
                setShowQrScanner(false);
                // Add friend by code
                setFriendCodeInput(parsed.code);
                const data = await addFriendByCode(parsed.code);
                showToast(data.message || 'Friend request sent!');
                if (data.user) setFriendStatuses(prev => ({ ...prev, [data.user.id]: data.status || 'pending' }));
              } else {
                setQrScanError('Not a Flock QR code');
              }
            } catch {
              setQrScanError('Not a valid Flock QR code');
            }
          },
          () => {} // ignore scan failures (no QR in frame)
        );
      } catch (err) {
        console.error('[QR Scanner] Start error:', err);
        setQrScanError(err.message || 'Could not access camera');
      }
    }, 300);
  }, [showToast]);

  const stopQrScanner = useCallback(async () => {
    if (qrScannerRef.current) {
      try { await qrScannerRef.current.stop(); } catch {}
      qrScannerRef.current = null;
    }
    setShowQrScanner(false);
    setQrScanError('');
  }, []);

  // Flock invites
  const [pendingFlockInvites, setPendingFlockInvites] = useState([]);
  const [showFlockInviteModal, setShowFlockInviteModal] = useState(false);
  const [flockInviteSearch, setFlockInviteSearch] = useState('');
  const [flockInviteSearching, setFlockInviteSearching] = useState(false);
  const [flockInviteResults, setFlockInviteResults] = useState([]);
  const [flockInviteSelected, setFlockInviteSelected] = useState([]);
  const [flockInviteSending, setFlockInviteSending] = useState(false);

  // Flock invite search (searches friends list)
  const flockInviteTimerRef = useRef(null);
  const handleFlockInviteSearch = useCallback((val) => {
    setFlockInviteSearch(val);
    if (flockInviteTimerRef.current) clearTimeout(flockInviteTimerRef.current);
    if (val.trim().length < 1) { setFlockInviteResults([]); return; }
    setFlockInviteSearching(true);
    flockInviteTimerRef.current = setTimeout(async () => {
      try {
        const data = await getFriends();
        const friends = (data.friends || []).filter(f =>
          f.name.toLowerCase().includes(val.toLowerCase())
        );
        setFlockInviteResults(friends);
      } catch { setFlockInviteResults([]); }
      finally { setFlockInviteSearching(false); }
    }, 300);
  }, []);

  // Send flock invites
  const handleSendFlockInvites = useCallback(async () => {
    if (flockInviteSelected.length === 0 || !selectedFlockId) return;
    setFlockInviteSending(true);
    try {
      const userIds = flockInviteSelected.map(f => f.id);
      await inviteToFlock(selectedFlockId, userIds);
      emitFlockInvite(selectedFlockId, userIds);
      showToast(`Invited ${flockInviteSelected.length} friend${flockInviteSelected.length > 1 ? 's' : ''}!`);
      setShowFlockInviteModal(false);
      setFlockInviteSelected([]);
      setFlockInviteSearch('');
      setFlockInviteResults([]);
    } catch (err) {
      showToast(err.message || 'Failed to send invites', 'error');
    } finally {
      setFlockInviteSending(false);
    }
  }, [flockInviteSelected, selectedFlockId, showToast]);

  // Accept a flock invite
  const handleAcceptFlockInvite = useCallback(async (flockId) => {
    try {
      await acceptFlockInvite(flockId);
      emitFlockInviteResponse(flockId, 'accepted');
      const invite = pendingFlockInvites.find(f => f.id === flockId);
      if (invite) {
        setPendingFlockInvites(prev => prev.filter(f => f.id !== flockId));
        setFlocks(prev => [...prev, { ...invite, memberStatus: 'accepted' }]);
      }
      showToast(`Joined ${invite?.name || 'flock'}!`);
    } catch (err) {
      showToast(err.message || 'Failed to accept invite', 'error');
    }
  }, [pendingFlockInvites, showToast]);

  // Decline a flock invite
  const handleDeclineFlockInvite = useCallback(async (flockId) => {
    try {
      await declineFlockInvite(flockId);
      emitFlockInviteResponse(flockId, 'declined');
      setPendingFlockInvites(prev => prev.filter(f => f.id !== flockId));
      showToast('Invite declined');
    } catch (err) {
      showToast(err.message || 'Failed to decline invite', 'error');
    }
  }, [showToast]);

  // Loading & Gamification
  const [isLoading, setIsLoading] = useState(false);
  const [userXP, setUserXP] = useState(280);
  const [userLevel, setUserLevel] = useState(3);
  const [streak] = useState(5);

  // Animations
  const [activeTabAnimation, setActiveTabAnimation] = useState(null);
  const [scrollY, setScrollY] = useState(0);
  const [swipeState, setSwipeState] = useState({ id: null, x: 0, startX: 0 });

  const handleScroll = useCallback((e) => {
    setScrollY(e.target.scrollTop);
  }, []);

  // Swipe gesture handlers
  const handleTouchStart = useCallback((id, e) => {
    setSwipeState({ id, x: 0, startX: e.touches[0].clientX });
  }, []);

  const handleTouchMove = useCallback((id, e) => {
    if (swipeState.id !== id) return;
    const diff = e.touches[0].clientX - swipeState.startX;
    if (diff > 0) { // Only allow right swipe
      setSwipeState(prev => ({ ...prev, x: Math.min(diff, 80) }));
    }
  }, [swipeState.id, swipeState.startX]);

  const handleTouchEnd = useCallback((id, message, e) => {
    if (swipeState.id !== id) return;
    if (swipeState.x > 50) {
      // Trigger reply
      setReplyingTo(message);
    }
    setSwipeState({ id: null, x: 0, startX: 0 });
  }, [swipeState.id, swipeState.x]);

  const addXP = useCallback((amount) => {
    setUserXP(prev => {
      const newXP = prev + amount;
      const newLevel = Math.floor(newXP / 100) + 1;
      if (newLevel > userLevel) {
        setUserLevel(newLevel);
        showToast(`🎉 Level Up! Level ${newLevel}!`);
      }
      return newXP;
    });
  }, [userLevel, showToast]);

  // AI Assistant
  const [aiMessages, setAiMessages] = useState([
    { role: 'assistant', text: "Hey! I'm your Flock assistant. I can help you find venues, check crowd levels, and coordinate plans with friends. What can I help you with?" }
  ]);
  const [aiInput, setAiInput] = useState('');
  const [aiTyping, setAiTyping] = useState(false);
  const [showAiAssistant, setShowAiAssistant] = useState(false);

  // Calendar
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventVenue, setNewEventVenue] = useState('');

  // Stories (fetched from API)
  const [stories, setStories] = useState([]);

  useEffect(() => {
    getStories()
      .then(data => {
        const avatarEmojis = ['😎', '🔥', '✨', '🎉', '🚀', '💪', '🎨', '🌟', '🎯', '🍕'];
        const mapped = (data.story_groups || []).map((g, i) => ({
          id: g.user_id,
          name: g.user_name.split(' ')[0],
          avatar: avatarEmojis[i % avatarEmojis.length],
          hasNew: true,
          storyData: g.stories,
        }));
        setStories(mapped);
      })
      .catch(() => setStories([]));
  }, []);

  // Story viewer state
  const [viewingStory, setViewingStory] = useState(null);
  const [storyIndex, setStoryIndex] = useState(0);

  // Activity feed (defined after Icons object below)

  // Flocks
  const [flocks, setFlocks] = useState([]);
  const [, setFlocksLoading] = useState(true);

  // Fetch flocks from API on mount
  useEffect(() => {
    setFlocksLoading(true);
    getFlocks()
      .then((data) => {
        const mapped = (data.flocks || []).map(f => ({
          id: f.id,
          name: f.name,
          host: f.creator_name || 'Unknown',
          creatorId: f.creator_id,
          memberStatus: f.member_status,
          members: [],
          memberCount: f.member_count || 1,
          time: f.event_time ? new Date(f.event_time).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'TBD',
          status: f.status === 'planning' ? 'voting' : f.status,
          venue: f.venue_name || 'TBD',
          venueAddress: f.venue_address || null,
          venueId: f.venue_id || null,
          venueLat: f.venue_latitude || null,
          venueLng: f.venue_longitude || null,
          venuePhoto: f.venue_photo_url || null,
          venueRating: f.venue_rating || null,
          venuePriceLevel: f.venue_price_level || null,
          cashPool: null,
          votes: [],
          messages: [],
        }));
        setFlocks(mapped.filter(f => f.memberStatus === 'accepted'));
        setPendingFlockInvites(mapped.filter(f => f.memberStatus === 'invited'));
      })
      .catch(() => setFlocks([]))
      .finally(() => setFlocksLoading(false));
  }, []);

  // Flock ordering & pinning (persisted in localStorage)
  const [pinnedFlockIds, setPinnedFlockIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('flock_pinned') || '[]'); } catch { return []; }
  });
  const [flockOrder, setFlockOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem('flock_order') || '[]'); } catch { return []; }
  });
  const [editingFlockList, setEditingFlockList] = useState(false);

  // Persist pin/order changes
  useEffect(() => { localStorage.setItem('flock_pinned', JSON.stringify(pinnedFlockIds)); }, [pinnedFlockIds]);
  useEffect(() => { localStorage.setItem('flock_order', JSON.stringify(flockOrder)); }, [flockOrder]);

  // Create Flock form
  const [flockName, setFlockName] = useState('');
  const [flockDate, setFlockDate] = useState('Tonight');
  const [flockTime, setFlockTime] = useState('9 PM');
  const [flockFriends, setFlockFriends] = useState([]); // Array of { id, name, email, profile_image_url }
  const [inviteSearch, setInviteSearch] = useState('');
  const [inviteResults, setInviteResults] = useState([]);
  const [inviteSearching, setInviteSearching] = useState(false);
  const [suggestedUsers, setSuggestedUsers] = useState([]);
  const [flockCashPool, setFlockCashPool] = useState(false);
  const [flockAmount, setFlockAmount] = useState(20);
  const [joinCode, setJoinCode] = useState('');

  // Explore
  // searchText removed — filtering handled by venue search
  const [category, setCategory] = useState('All');
  const [activeVenue, setActiveVenue] = useState(null);
  const [venueDetailModal, setVenueDetailModal] = useState(null); // full venue details for modal
  const [, setVenueDetailLoading] = useState(false);
  const [venueDetailPhotoIdx, setVenueDetailPhotoIdx] = useState(0);
  const [showConnectPanel, setShowConnectPanel] = useState(false);
  const [connectSearch, setConnectSearch] = useState('');
  const [connectResults, setConnectResults] = useState([]);
  const [connectSearching, setConnectSearching] = useState(false);
  const [friendStatuses, setFriendStatuses] = useState({}); // { [userId]: 'pending' | 'accepted' }

  // Chat
  const [chatInput, setChatInput] = useState('');
  const [showChatPool, setShowChatPool] = useState(false);
  const [chatPoolAmount, setChatPoolAmount] = useState(20);
  const chatEndRef = useRef(null);
  const aiInputRef = useRef(null);
  const [isTyping, setIsTyping] = useState(false);
  const [typingUser, setTypingUser] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [showChatSearch, setShowChatSearch] = useState(false);
  const chatSearchRef = useRef(null);

  // Live location sharing
  const [sharingLocationForFlock, setSharingLocationForFlock] = useState(null); // { flockId, watchId }
  const [flockMemberLocations, setFlockMemberLocations] = useState({}); // userId -> { lat, lng, name, timestamp }
  const [locationBannerDismissed, setLocationBannerDismissed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('flock_loc_dismissed') || '{}'); } catch { return {}; }
  });
  const chatListSearchRef = useRef(null);
  const searchResultsInputRef = useRef(null);

  // Keep chat search input focused after re-renders
  useEffect(() => {
    if (showChatSearch && chatSearchRef.current) {
      chatSearchRef.current.focus();
    }
  }, [showChatSearch, chatSearch]);

  const [replyingTo, setReplyingTo] = useState(null);
  const [showReactionPicker, setShowReactionPicker] = useState(null);
  const [showVenueShareModal, setShowVenueShareModal] = useState(false);
  const [showVotePanel, setShowVotePanel] = useState(false);
  const [popularVenues, setPopularVenues] = useState([]);
  const [pendingImage, setPendingImage] = useState(null);
  const [showImagePreview, setShowImagePreview] = useState(false);
  const [showCameraPopup, setShowCameraPopup] = useState(false);
  const [showCameraViewfinder, setShowCameraViewfinder] = useState(null); // 'flock' or 'dm'
  const cameraVideoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const chatGalleryInputRef = useRef(null);
  const [showFlockMenu, setShowFlockMenu] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  // Direct Messages
  const [directMessages, setDirectMessages] = useState([]);
  const [selectedDmId, setSelectedDmId] = useState(null);
  const [showNewDmModal, setShowNewDmModal] = useState(false);
  const [dmSearchText, setDmSearchText] = useState('');
  const [showDmMenu, setShowDmMenu] = useState(false);
  const [showDeleteDmConfirm, setShowDeleteDmConfirm] = useState(false);
  const [deletedDmUserIds, setDeletedDmUserIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('flock_deleted_dms') || '[]'); } catch { return []; }
  });
  const [dmIsTyping, setDmIsTyping] = useState(false);
  const [dmTypingUser, setDmTypingUser] = useState('');
  const dmTypingTimeoutRef = useRef(null);
  const dmChatEndRef = useRef(null);
  const [dmChatSearch, setDmChatSearch] = useState('');
  const [showDmChatSearch, setShowDmChatSearch] = useState(false);
  const dmChatSearchRef = useRef(null);
  const [dmReplyingTo, setDmReplyingTo] = useState(null);
  const [showDmReactionPicker, setShowDmReactionPicker] = useState(null);
  const [showDmVotePanel, setShowDmVotePanel] = useState(false);
  const [dmVenueVotes, setDmVenueVotes] = useState([]);
  const [showDmVenueSearch, setShowDmVenueSearch] = useState(false);
  const [dmPendingImage, setDmPendingImage] = useState(null);
  const [showDmImagePreview, setShowDmImagePreview] = useState(false);
  const [showDmCameraPopup, setShowDmCameraPopup] = useState(false);
  const dmGalleryInputRef = useRef(null);
  const [dmSharingLocation, setDmSharingLocation] = useState(null); // userId we're sharing with
  const [dmMemberLocation, setDmMemberLocation] = useState(null); // { lat, lng, name, timestamp }
  const [showDmCashPool, setShowDmCashPool] = useState(false);
  const [dmCashPoolAmount, setDmCashPoolAmount] = useState(20);
  const [dmCashPool, setDmCashPool] = useState(null); // { perPerson, total, collected, paid: [] }
  const [dmPinnedVenue, setDmPinnedVenue] = useState(null); // { name, addr, place_id, rating, photo_url }
  const [pickingVenueForDm, setPickingVenueForDm] = useState(false);

  // Profile
  const [profileScreen, setProfileScreen] = useState('main');
  const [profileName, setProfileName] = useState(authUser?.name || '');
  const [profileHandle, setProfileHandle] = useState(authUser?.email?.split('@')[0] || '');
  const [profileBio] = useState('Love exploring new places!'); // eslint-disable-line no-unused-vars
  const [profilePic, setProfilePic] = useState(null);
  const [showPicModal, setShowPicModal] = useState(false);
  const [trustedContacts, setTrustedContacts] = useState([]);
  const [safetyOn, setSafetyOn] = useState(true);
  const [showAddContact, setShowAddContact] = useState(false);
  const [editingContact, setEditingContact] = useState(null); // null or contact object
  const [newContact, setNewContact] = useState({ name: '', phone: '', email: '', relationship: '' });
  const [safetyLoading, setSafetyLoading] = useState(false);
  const [sosAlertSending, setSosAlertSending] = useState(false);

  // Interests
  const [userInterests, setUserInterests] = useState(['Live Music', 'Cocktails', 'Nightlife']);
  const [newInterest, setNewInterest] = useState('');
  const suggestedInterests = ['Sports', 'Food', 'Dancing', 'Karaoke', 'Comedy', 'Art', 'Wine', 'Beer', 'Trivia', 'Pool', 'Darts', 'Gaming'];

  // Payment Methods
  const [paymentMethods, setPaymentMethods] = useState([
    { id: 1, brand: 'Visa', last4: '4242', expiry: '12/26', isDefault: true },
  ]);
  const [showAddCard, setShowAddCard] = useState(false);
  const [newCard, setNewCard] = useState({ number: '', expiry: '', cvv: '', name: '' });

  // Modals
  const [showSOS, setShowSOS] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);

  // Admin Mode (for Revenue Simulator access)
  const [showAdminPrompt, setShowAdminPrompt] = useState(false);

  // Venue Dashboard (for venue owners)
  const [venueTier, setVenueTier] = useState('free'); // 'free', 'premium', 'pro'
  const [venueTab, setVenueTab] = useState('analytics'); // Lifted to App level to persist across re-renders
  const [adminTab, setAdminTab] = useState('revenue'); // Lifted to App level to persist across re-renders

  // Check URL for admin/venue mode on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('admin') === 'true') {
      setCurrentScreen('adminRevenue');
    }
    if (urlParams.get('venue') === 'true') {
      setVenueTier(urlParams.get('tier') || 'free');
      setCurrentScreen('venueDashboard');
    }
  }, []);

  // Focus AI input when modal opens
  useEffect(() => {
    if (showAiAssistant && aiInputRef.current) {
      setTimeout(() => aiInputRef.current?.focus(), 100);
    }
  }, [showAiAssistant]);

  // Map venues loaded from Google Places API
  // Start empty — venues load from API based on user's actual location
  const [allVenues, setAllVenues] = useState([]);
  const [mapVenuesLoaded, setMapVenuesLoaded] = useState(false);

  // Seed venues - shown when API is unavailable (rate limited, no key, offline)
  const seedVenues = useMemo(() => [
    { place_id: 'seed_1', name: 'The Bookstore Speakeasy', formatted_address: '336 Adams St, Bethlehem, PA', rating: 4.6, user_ratings_total: 312, price_level: 2, types: ['bar', 'night_club'], location: { latitude: 40.6262, longitude: -75.3775 } },
    { place_id: 'seed_2', name: 'Molinari\'s', formatted_address: '322 E 3rd St, Bethlehem, PA', rating: 4.5, user_ratings_total: 287, price_level: 2, types: ['restaurant', 'italian_restaurant'], location: { latitude: 40.6178, longitude: -75.3683 } },
    { place_id: 'seed_3', name: 'Bonn Place Brewing', formatted_address: '302 Brodhead Ave, Bethlehem, PA', rating: 4.7, user_ratings_total: 198, price_level: 2, types: ['bar', 'brewery'], location: { latitude: 40.6130, longitude: -75.3780 } },
    { place_id: 'seed_4', name: 'Social Still', formatted_address: '530 E 3rd St, Bethlehem, PA', rating: 4.4, user_ratings_total: 245, price_level: 2, types: ['bar', 'restaurant'], location: { latitude: 40.6180, longitude: -75.3650 } },
    { place_id: 'seed_5', name: 'Twisted Olive', formatted_address: '101 W Broad St, Bethlehem, PA', rating: 4.3, user_ratings_total: 189, price_level: 2, types: ['restaurant', 'mediterranean_restaurant'], location: { latitude: 40.6260, longitude: -75.3810 } },
    { place_id: 'seed_6', name: 'McCarthy\'s Red Stag', formatted_address: '16 W 3rd St, Bethlehem, PA', rating: 4.2, user_ratings_total: 156, price_level: 1, types: ['bar', 'restaurant'], location: { latitude: 40.6185, longitude: -75.3780 } },
    { place_id: 'seed_7', name: 'Tapas on Main', formatted_address: '500 Main St, Bethlehem, PA', rating: 4.5, user_ratings_total: 220, price_level: 3, types: ['restaurant', 'spanish_restaurant'], location: { latitude: 40.6258, longitude: -75.3755 } },
    { place_id: 'seed_8', name: 'ArtsQuest Center', formatted_address: '101 Founders Way, Bethlehem, PA', rating: 4.6, user_ratings_total: 402, price_level: 2, types: ['performing_arts_theater', 'live_music_venue'], location: { latitude: 40.6150, longitude: -75.3770 } },
  ], []);

  // Ref to track if initial venue load has been attempted (survives re-renders)
  const venueLoadAttemptedRef = useRef(false);

  // Load diverse popular chain venues for vote panels (independent of map search)
  const loadPopularVenues = useCallback(() => {
    if (!userLocation) return;
    const locStr = `${userLocation.lat},${userLocation.lng}`;
    const cacheKey = `popular_vote|${locStr}`;
    const cached = searchCacheRef.current[cacheKey];
    if (cached && Date.now() - cached.timestamp < 300000) {
      setPopularVenues(venuesToMapPins(cached.data));
      return;
    }
    searchVenues('popular restaurants cafes bars fast food', locStr)
      .then(data => {
        const venues = data.venues || [];
        searchCacheRef.current[cacheKey] = { data: venues, timestamp: Date.now() };
        setPopularVenues(venuesToMapPins(venues));
      })
      .catch(() => {});
  }, [userLocation, venuesToMapPins]);

  // Core venue loading function
  const loadVenuesAtLocation = useCallback((lat, lng) => {
    console.log('[Geo] Loading venues near:', lat, lng);
    setUserLocation({ lat, lng });
    localStorage.setItem('flock_user_lat', String(lat));
    localStorage.setItem('flock_user_lng', String(lng));
    const locStr = `${lat},${lng}`;
    const cacheKey = `nearby|${locStr}`;
    const cached = searchCacheRef.current[cacheKey];
    if (cached && Date.now() - cached.timestamp < 300000) {
      console.log('[Geo] Using cached nearby venues');
      setAllVenues(venuesToMapPins(cached.data));
      setMapVenuesLoaded(true);
      return;
    }

    // Single query for popular venues nearby (1 API call instead of 8)
    searchVenues('popular restaurants cafes bars fast food', locStr)
      .then((data) => {
        const venues = data.venues || [];
        searchCacheRef.current[cacheKey] = { data: venues, timestamp: Date.now() };
        setAllVenues(venuesToMapPins(venues));
        setMapVenuesLoaded(true);
      })
      .catch((err) => {
        console.error('[Geo] Nearby venue search failed:', err);
        setAllVenues(venuesToMapPins(seedVenues));
        setMapVenuesLoaded(true);
      });
  }, [venuesToMapPins, seedVenues]);

  // Request user geolocation and load venues
  // forceRefresh=true forces fresh GPS + reloads popular chains near user
  const requestUserLocation = useCallback((forceRefresh = false) => {
    const savedLat = localStorage.getItem('flock_user_lat');
    const savedLng = localStorage.getItem('flock_user_lng');

    // Use saved location immediately so map has data right away
    if (!forceRefresh && savedLat && savedLng) {
      const lat = parseFloat(savedLat);
      const lng = parseFloat(savedLng);
      setUserLocation({ lat, lng }); // Set blue dot immediately
      loadVenuesAtLocation(lat, lng);
    }

    if (!navigator.geolocation) {
      if (!savedLat) {
        loadVenuesAtLocation(40.5798, -75.2932);
      }
      return;
    }

    setLocationLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        console.log('[Geo] Got position:', latitude, longitude);
        setLocationLoading(false);
        loadVenuesAtLocation(latitude, longitude);
        if (forceRefresh && window.__flockGoToMyLocation) {
          window.__flockGoToMyLocation();
        }
      },
      (err) => {
        console.warn('[Geo] Geolocation error:', err.code, err.message);
        setLocationLoading(false);
        if (savedLat && savedLng && !forceRefresh) {
          // Already loaded from saved above
        } else {
          loadVenuesAtLocation(40.5798, -75.2932);
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: forceRefresh ? 0 : 30000 }
    );
  }, [loadVenuesAtLocation]);

  // Load venues on mount
  useEffect(() => {
    if (!venueLoadAttemptedRef.current) {
      venueLoadAttemptedRef.current = true;
      requestUserLocation();
    }
  }, [requestUserLocation]);

  const getSelectedFlock = useCallback(() => flocks.find(f => f.id === selectedFlockId) || flocks[0], [flocks, selectedFlockId]);

  // Haversine distance between two lat/lng points
  const calcDistance = useCallback((lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
  }, []);

  const formatDateStr = (d) => d.toISOString().split('T')[0];
  const getDaysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const getFirstDayOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  const getEventsForDate = useCallback((dateStr) => calendarEvents.filter(e => e.date === dateStr), [calendarEvents]);

  const addEventToCalendar = useCallback((title, venue, date, time, color) => {
    setCalendarEvents(prev => [...prev, { id: Date.now(), title, venue, date: typeof date === 'string' ? date : formatDateStr(date), time, color: color || colors.navy, members: 1 }]);
    // Toast removed
  }, []);

  const addMessageToFlock = useCallback((flockId, message) => {
    setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, messages: [...f.messages, message] } : f));
  }, []);

  const updateFlockVotes = useCallback((flockId, newVotes) => {
    setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, votes: newVotes } : f));
  }, []);

  // Assign or change venue on a flock (updates local state + API)
  const updateFlockVenue = useCallback((flockId, venue) => {
    const vName = venue.name;
    const vAddr = venue.addr || venue.formatted_address || '';
    const vId = venue.place_id || null;
    const vLat = venue.lat || venue.location?.latitude || null;
    const vLng = venue.lng || venue.location?.longitude || null;
    const vPhoto = venue.photo_url || null;
    const vRating = venue.stars || venue.rating || null;
    const vPriceLevel = venue.price_level || null;
    // Update local state immediately
    setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, venue: vName, venueAddress: vAddr, venueId: vId, venueLat: vLat, venueLng: vLng, venuePhoto: vPhoto, venueRating: vRating, venuePriceLevel: vPriceLevel } : f));
    // Also update the API
    const token = localStorage.getItem('flockToken');
    if (token && typeof flockId === 'number') {
      fetch(`${BASE_URL}/api/flocks/${flockId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ venue_name: vName, venue_address: vAddr, venue_id: vId, venue_latitude: vLat, venue_longitude: vLng, venue_rating: vRating, venue_photo_url: vPhoto }),
      }).catch(err => console.error('Failed to update flock venue:', err));
    }
    // Toast removed — venue updates visually
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const makePoolPayment = useCallback((flockId) => {
    setFlocks(prev => prev.map(f => {
      if (f.id === flockId && f.cashPool && !f.cashPool.paid.includes('You')) {
        return { ...f, cashPool: { ...f.cashPool, paid: [...f.cashPool.paid, 'You'], collected: f.cashPool.collected + f.cashPool.perPerson } };
      }
      return f;
    }));
    addXP(20);
    // Toast removed
  }, [addXP]);

  // AI Response Generation - Professional but friendly assistant
  const generateAiResponse = useCallback((userMsg, venueList, flockList, friendsList) => {
    const msg = userMsg.toLowerCase();
    const findVenue = (name) => venueList.find(v => v.name.toLowerCase().includes(name.toLowerCase()));
    const busyVenues = venueList.filter(v => v.crowd >= 70).sort((a, b) => b.crowd - a.crowd);
    const quietVenues = venueList.filter(v => v.crowd < 50).sort((a, b) => a.crowd - b.crowd);

    // VENUE QUESTIONS - Busy/Crowded
    if (msg.includes('busy') || msg.includes('crowded') || msg.includes('packed') || msg.includes('crowd') || msg.includes('poppin')) {
      if (busyVenues.length > 0) {
        const busy = busyVenues[0];
        const quiet = quietVenues[0];
        return { text: `${busy.name} is currently at ${busy.crowd}% capacity - quite busy! ${quiet ? `If you'd prefer somewhere quieter, ${quiet.name} is only at ${quiet.crowd}%.` : 'Most other venues have moderate crowds.'}`, confidence: 94 };
      }
      return { text: "Most venues have light crowds right now - you should be able to get in anywhere without a wait.", confidence: 85 };
    }

    // VENUE QUESTIONS - Recommendations
    if (msg.includes('where should') || msg.includes('recommend') || msg.includes('suggestion') || msg.includes('what venue') || msg.includes('where to go') || msg.includes('pick')) {
      const topRated = venueList.filter(v => v.stars >= 4.5).sort((a, b) => b.stars - a.stars)[0];
      const trending = venueList.find(v => v.trending);
      if (trending) {
        return { text: `${trending.name} is trending tonight. ${topRated && topRated.name !== trending.name ? `Alternatively, ${topRated.name} has excellent reviews (${topRated.stars} stars) if you prefer a smaller crowd.` : ''}`, confidence: 91 };
      }
      if (topRated) {
        return { text: `I'd recommend ${topRated.name} - it has a ${topRated.stars}-star rating, currently at ${topRated.crowd}% capacity. Great ${topRated.type} spot.`, confidence: 89 };
      }
    }

    // PLANNING QUESTIONS
    if (msg.includes('plan') || msg.includes('organize') || msg.includes('coordinate') || msg.includes('create') || msg.includes('start a flock') || msg.includes('make a flock') || msg.includes('rally')) {
      const upcomingFlock = flockList.find(f => f.status === 'voting');
      return { text: `Ready to coordinate plans! ${upcomingFlock ? `Note: "${upcomingFlock.name}" still needs votes from your group.` : 'Tap "Start a Flock" to create a new plan and invite friends.'}`, confidence: 95 };
    }

    // FOOD QUESTIONS
    if (msg.includes('food') || msg.includes('eat') || msg.includes('hungry') || msg.includes('restaurant') || msg.includes('pizza') || msg.includes('taco')) {
      const foodVenues = venueList.filter(v => v.category === 'Food').sort((a, b) => b.stars - a.stars);
      if (foodVenues.length > 0) {
        const top = foodVenues[0];
        return { text: `For food, I'd suggest ${top.name} - ${top.stars} stars, ${top.price} price range, currently at ${top.crowd}% capacity.`, confidence: 92 };
      }
    }

    // NIGHTLIFE QUESTIONS
    if (msg.includes('bar') || msg.includes('drink') || msg.includes('nightlife') || msg.includes('club') || msg.includes('party')) {
      const nightlife = venueList.filter(v => v.category === 'Nightlife').sort((a, b) => b.stars - a.stars);
      if (nightlife.length > 0) {
        const top = nightlife[0];
        return { text: `${top.name} is a great option - ${top.stars} stars, currently at ${top.crowd}% capacity. Best time to arrive: ${top.best}.`, confidence: 90 };
      }
    }

    // SPECIFIC VENUE QUESTIONS
    const venueNames = ['blue heron', 'bookstore', 'godfrey', 'apollo', 'tulum', 'dime', 'rooftop', 'porters'];
    for (const name of venueNames) {
      if (msg.includes(name)) {
        const venue = findVenue(name);
        if (venue) {
          const crowdComment = venue.crowd > 70 ? 'Currently very busy.' : venue.crowd > 40 ? 'Moderate crowd.' : 'Light crowd right now.';
          return { text: `${venue.name}: ${crowdComment} (${venue.crowd}% capacity). ${venue.stars} stars. Best time: ${venue.best}. Located at ${venue.addr}.`, confidence: 96 };
        }
      }
    }

    // FRIEND QUESTIONS
    if (msg.includes('friend') || msg.includes('who') || friendsList.some(f => msg.includes(f.toLowerCase()))) {
      const mentionedFriend = friendsList.find(f => msg.includes(f.toLowerCase()));
      if (mentionedFriend) {
        const randomVenue = venueList[Math.floor(Math.random() * venueList.length)];
        return { text: `${mentionedFriend} was last active near ${randomVenue.name}. Would you like to start a flock and invite them?`, confidence: 78 };
      }
      return { text: `Your friends: ${friendsList.slice(0, 3).join(', ')} are available. Would you like to start coordinating plans?`, confidence: 82 };
    }

    // TIME/SCHEDULE QUESTIONS
    if (msg.includes('time') || msg.includes('when') || msg.includes('schedule') || msg.includes('tonight') || msg.includes('best time')) {
      const bestVenue = venueList.find(v => v.best.includes('Now')) || venueList[0];
      return { text: `${bestVenue.name} is ideal right now. Generally, most venues are best between 9-10 PM. Arriving earlier helps avoid wait times.`, confidence: 87 };
    }

    // HELP QUESTIONS
    if (msg.includes('help') || msg.includes('how do') || msg.includes('how does') || msg.includes('what can you')) {
      return { text: "I can help you with:\n\n• Check crowd levels at venues\n• Get venue recommendations\n• Coordinate plans with friends\n• Find the best time to arrive\n• See where friends are\n\nJust ask and I'll assist!", confidence: 100 };
    }

    // GREETING
    if (msg.includes('hi') || msg.includes('hello') || msg.includes('hey') || msg.includes('sup') || msg === 'yo') {
      const greetings = ["Hey there!", "Hello!", "Hi! How can I help?"];
      return { text: `${greetings[Math.floor(Math.random() * greetings.length)]} I can help you find venues, check crowds, or coordinate plans with friends. What would you like to do?`, confidence: 100 };
    }

    // THANKS
    if (msg.includes('thank') || msg.includes('thanks') || msg.includes('awesome') || msg.includes('great') || msg.includes('perfect')) {
      const responses = ["Happy to help!", "You're welcome! Have a great time.", "Glad I could assist!"];
      return { text: responses[Math.floor(Math.random() * responses.length)], confidence: 100 };
    }

    // DEFAULT
    return { text: "I'm not sure I understood that. I can help you with: finding venues, checking crowd levels, and coordinating plans with friends. Try asking \"where should we go?\" or \"how busy is it?\"", confidence: 65 };
  }, []);

  const sendAiMessage = useCallback(() => {
    if (!aiInput.trim()) return;
    const userMessage = aiInput.trim();
    setAiMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setAiInput('');
    setAiTyping(true);
    setTimeout(() => {
      const response = generateAiResponse(userMessage, allVenues, flocks, []);
      setAiMessages(prev => [...prev, { role: 'assistant', text: response.text, confidence: response.confidence }]);
      setAiTyping(false);
      if (aiInputRef.current) aiInputRef.current.focus();
    }, 1200 + Math.random() * 800);
  }, [aiInput, generateAiResponse, allVenues, flocks]);

  // Auto-scroll chat to bottom when messages change
  const selectedFlock = flocks.find(f => f.id === selectedFlockId) || flocks[0];
  useEffect(() => {
    if (currentScreen === 'chatDetail' && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedFlock?.messages, currentScreen]);

  // Load suggested users when opening Create screen
  useEffect(() => {
    if (currentScreen === 'create') loadSuggestedUsers();
    if (currentScreen === 'addFriends') loadAddFriendsData();
  }, [currentScreen, loadSuggestedUsers, loadAddFriendsData]);

  // Fetch messages from API + join socket room when opening a chat
  const [, setMessagesLoading] = useState(false);
  const prevFlockIdRef = useRef(null);
  const newlyCreatedFlockRef = useRef(null);
  const sharingLocationRef = useRef(sharingLocationForFlock);
  sharingLocationRef.current = sharingLocationForFlock;
  useEffect(() => {
    if (currentScreen === 'chatDetail' && selectedFlockId) {
      // Leave previous room
      if (prevFlockIdRef.current && prevFlockIdRef.current !== selectedFlockId) {
        leaveFlock(prevFlockIdRef.current);
      }
      prevFlockIdRef.current = selectedFlockId;

      // Join socket room
      joinFlock(selectedFlockId);

      // Fetch flock members
      getFlock(selectedFlockId)
        .then((data) => {
          const members = (data.members || []).filter(m => m.status === 'accepted').map(m => ({ id: m.id, name: m.name, image: m.profile_image_url || null }));
          setFlocks(prev => prev.map(f => f.id === selectedFlockId ? { ...f, members, memberCount: members.length } : f));
        })
        .catch(() => {});

      // Skip message fetch for just-created flocks (we already have the messages locally)
      if (newlyCreatedFlockRef.current === selectedFlockId) {
        newlyCreatedFlockRef.current = null;
      } else {
        // Fetch message history via HTTP
        setMessagesLoading(true);
        getMessages(selectedFlockId)
          .then((data) => {
            const msgs = (data.messages || []).map(m => ({
              id: m.id,
              sender: m.sender_name || 'Unknown',
              time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
              text: m.message_text,
              message_type: m.message_type || 'text',
              venue_data: m.venue_data || null,
              reactions: (m.reactions || []).map(r => r.emoji),
              ...(m.image_url ? { image: m.image_url } : {}),
            }));
            setFlocks(prev => prev.map(f => f.id === selectedFlockId ? { ...f, messages: msgs } : f));
          })
          .catch(() => {})
          .finally(() => setMessagesLoading(false));
      }
    } else if (currentScreen !== 'chatDetail' && prevFlockIdRef.current) {
      // Don't leave socket room if actively sharing location (need to keep receiving updates)
      if (!sharingLocationRef.current || sharingLocationRef.current !== prevFlockIdRef.current) {
        leaveFlock(prevFlockIdRef.current);
      }
      prevFlockIdRef.current = null;
    }
  }, [currentScreen, selectedFlockId]);

  // Listen for real-time messages via WebSocket
  useEffect(() => {
    const unsub = onNewMessage((msg) => {
      // Don't duplicate own messages (loose equality handles string/number mismatch)
      if (String(msg.sender_id) === String(authUser?.id)) return;
      const mapped = {
        id: msg.id,
        sender: msg.sender_name || 'Unknown',
        time: new Date(msg.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        text: msg.message_text,
        message_type: msg.message_type || 'text',
        venue_data: msg.venue_data || null,
        reactions: [],
        ...(msg.image_url ? { image: msg.image_url } : {}),
      };
      setFlocks(prev => prev.map(f => {
        if (f.id !== msg.flock_id) return f;
        // Deduplicate — skip if message ID already exists
        if ((f.messages || []).some(m => m.id === msg.id)) return f;
        return { ...f, messages: [...(f.messages || []), mapped] };
      }));
    });
    return unsub;
  }, [authUser]);

  // Listen for typing indicators via WebSocket
  useEffect(() => {
    const unsubTyping = onUserTyping((data) => {
      setTypingUser(data.name);
      setIsTyping(true);
    });
    const unsubStop = onUserStoppedTyping(() => {
      setIsTyping(false);
      setTypingUser('');
    });
    return () => { unsubTyping(); unsubStop(); };
  }, []);

  // --- Live location sharing ---

  const startSharingLocation = useCallback((flockId) => {
    if (!userLocation) {
      // Toast removed — banner shows location status
      return;
    }
    console.log('[Location] Started sharing for flock:', flockId);
    emitLocation(flockId, userLocation.lat, userLocation.lng);
    setSharingLocationForFlock(flockId);
  }, [userLocation]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopLocationSharing = useCallback(() => {
    if (!sharingLocationForFlock) return;
    console.log('[Location] Stopped sharing');
    socketStopSharing(sharingLocationForFlock);
    setSharingLocationForFlock(null);
    setFlockMemberLocations({});
  }, [sharingLocationForFlock]);

  // Emit location every 10 seconds while sharing is active
  useEffect(() => {
    if (!sharingLocationForFlock || !userLocation) return;
    const interval = setInterval(() => {
      console.log('[Location] Emitting position:', userLocation.lat, userLocation.lng);
      emitLocation(sharingLocationForFlock, userLocation.lat, userLocation.lng);
    }, 10000);
    // Emit immediately on location change
    emitLocation(sharingLocationForFlock, userLocation.lat, userLocation.lng);
    return () => clearInterval(interval);
  }, [sharingLocationForFlock, userLocation]);

  // Auto-stop sharing when flock status changes from confirmed
  useEffect(() => {
    if (!sharingLocationForFlock) return;
    const flock = flocks.find(f => f.id === sharingLocationForFlock);
    if (!flock || flock.status !== 'confirmed') {
      stopLocationSharing();
    }
  }, [flocks, sharingLocationForFlock, stopLocationSharing]);

  // Listen for member location updates
  useEffect(() => {
    const unsubLocation = onLocationUpdate((data) => {
      console.log('[Location] Received member location:', data);
      setFlockMemberLocations(prev => ({
        ...prev,
        [data.userId]: { lat: data.lat, lng: data.lng, name: data.name, timestamp: data.timestamp },
      }));
    });
    const unsubStopped = onMemberStoppedSharing((data) => {
      setFlockMemberLocations(prev => {
        const next = { ...prev };
        delete next[data.userId];
        return next;
      });
    });
    return () => { unsubLocation(); unsubStopped(); };
  }, []);

  // Clean up location sharing on unmount
  useEffect(() => {
    return () => {
      if (sharingLocationForFlock) {
        socketStopSharing(sharingLocationForFlock);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for real-time flock invite notifications
  useEffect(() => {
    const unsubInvite = onFlockInviteReceived((data) => {
      setPendingFlockInvites(prev => {
        if (prev.some(f => f.id === data.flockId)) return prev;
        return [...prev, {
          id: data.flockId,
          name: data.flockName,
          host: data.invitedBy.name,
          memberStatus: 'invited',
          members: [],
          memberCount: 0,
          time: 'TBD',
          status: 'planning',
          venue: 'TBD',
          messages: [],
          votes: [],
        }];
      });
      showToast(`${data.invitedBy.name} invited you to ${data.flockName}`);
    });

    const unsubResponse = onFlockInviteResponded((data) => {
      if (data.action === 'accepted') {
        setFlocks(prev => prev.map(f =>
          f.id === data.flockId ? { ...f, memberCount: (f.memberCount || 0) + 1 } : f
        ));
      }
    });

    return () => { unsubInvite(); unsubResponse(); };
  }, [showToast]);

  // Listen for real-time friend request notifications
  useEffect(() => {
    const unsubReq = onFriendRequestReceived((data) => {
      setPendingRequests(prev => {
        if (prev.some(r => r.id === data.fromUserId)) return prev;
        return [{ id: data.fromUserId, name: data.fromUserName, profile_image_url: null, created_at: new Date().toISOString() }, ...prev];
      });
      showToast(`${data.fromUserName} sent you a friend request`);
    });

    const unsubResp = onFriendRequestResponded((data) => {
      if (data.action === 'accepted') {
        setOutgoingRequests(prev => prev.filter(r => r.id !== data.fromUserId));
        setFriendStatuses(prev => ({ ...prev, [data.fromUserId]: 'accepted' }));
        showToast(`${data.fromUserName} accepted your friend request!`);
      }
    });

    return () => { unsubReq(); unsubResp(); };
  }, [showToast]);

  // Typing indicator — emit via socket with debounce
  const typingTimeoutRef = useRef(null);
  const handleChatInputChange = useCallback((e) => {
    setChatInput(e.target.value);
    if (selectedFlockId) {
      startTyping(selectedFlockId);
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        stopTyping(selectedFlockId);
      }, 2000);
    }
  }, [selectedFlockId]);

  // Send chat message — emit via WebSocket, fall back to HTTP
  const sendChatMessage = useCallback(async () => {
    if (chatInput.trim()) {
      const text = chatInput;
      setChatInput('');
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        stopTyping(selectedFlockId);
      }

      // Optimistic local update
      const tempId = Date.now();
      addMessageToFlock(selectedFlockId, { id: tempId, sender: authUser?.name || 'You', time: 'Now', text, reactions: [] });
      addXP(5);

      // Send via WebSocket (instant) + HTTP (persistent)
      socketSendMessage(selectedFlockId, text);
      try {
        await apiSendMessage(selectedFlockId, text);
      } catch {
        // WebSocket already sent it, HTTP is just backup persistence
      }
    }
  }, [chatInput, selectedFlockId, addMessageToFlock, addXP, authUser]);

  const getCategoryColor = (cat) => {
    switch(cat) {
      case 'Food': return colors.food;
      case 'Nightlife': return colors.nightlife;
      case 'Live Music': return colors.music;
      case 'Sports': return colors.sports;
      default: return colors.navy;
    }
  };

  // Relative time formatter
  const getRelativeTime = (timeStr) => {
    if (!timeStr) return '';
    if (timeStr === 'Now') return 'Just now';
    if (timeStr.includes('ago') || timeStr === 'Yesterday') return timeStr;
    const times = { '5m': '5m ago', '10m': '10m ago', '1h': '1h ago', '2h': '2h ago' };
    return times[timeStr] || timeStr;
  };

  // SVG Icon Components
  const Icons = {
    heart: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>,
    thumbsUp: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>,
    flame: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none"><path d="M12 23c-4.97 0-9-3.58-9-8 0-3.19 2.13-6.02 5-8 0 2 1 4 3 5 0-3 2-5 4-7 1 1 2 3 2 5 2-1 3-3 3-5 2.87 1.98 5 4.81 5 8 0 4.42-4.03 8-9 8z"/></svg>,
    party: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>,
    mapPin: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>,
    calendar: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>,
    users: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
    userPlus: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>,
    shield: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>,
    sparkles: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"></path><path d="M5 19l.5 1.5L7 21l-1.5.5L5 23l-.5-1.5L3 21l1.5-.5L5 19z"></path><path d="M19 12l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z"></path></svg>,
    dollar: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>,
    vote: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"></path><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7z"></path><path d="M22 19H2"></path></svg>,
    pizza: (color = '#F97316', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 19h20L12 2z"></path><circle cx="12" cy="12" r="1"></circle><circle cx="9" cy="15" r="1"></circle><circle cx="15" cy="15" r="1"></circle></svg>,
    cocktail: (color = '#1a3a5c', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 22h8"></path><path d="M12 11v11"></path><path d="M3 3l18 0-6 8h-6z"></path></svg>,
    music: (color = '#2d5a87', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>,
    sports: (color = '#22C55E', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a15 15 0 0 0 0 20 15 15 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>,
    send: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>,
    mic: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>,
    image: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>,
    search: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>,
    check: (color = 'currentColor', size = 14) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>,
    checkDouble: (color = 'currentColor', size = 14) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 6 9 17 4 12"></polyline><polyline points="22 6 13 17"></polyline></svg>,
    reply: (color = 'currentColor', size = 16) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>,
    compass: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>,
    crosshair: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="22" y1="12" x2="18" y2="12"></line><line x1="6" y1="12" x2="2" y2="12"></line><line x1="12" y1="6" x2="12" y2="2"></line><line x1="12" y1="22" x2="12" y2="18"></line></svg>,
    trendingUp: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>,
    clock: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>,
    sun: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>,
    cloud: (color = '#9ca3af', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>,
    home: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>,
    user: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    wave: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"></path><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"></path><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"></path><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"></path></svg>,
    robot: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>,
    logout: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>,
    camera: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>,
    x: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>,
    plus: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    minus: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    arrowLeft: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>,
    arrowRight: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>,
    bell: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>,
    settings: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>,
    repeat: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>,
    zap: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>,
    activity: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>,
    building: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect><path d="M9 22v-4h6v4"></path><path d="M8 6h.01"></path><path d="M16 6h.01"></path><path d="M8 10h.01"></path><path d="M16 10h.01"></path><path d="M8 14h.01"></path><path d="M16 14h.01"></path></svg>,
    briefcase: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>,
    creditCard: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>,
    target: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>,
    star: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>,
    starFilled: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>,
    messageSquare: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>,
    tag: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>,
    gift: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"></rect><line x1="12" y1="22" x2="12" y2="7"></line><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg>,
    barChart: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>,
    pieChart: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path></svg>,
    edit: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>,
    trash: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
    lock: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>,
    map: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>,
    globe: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>,
    download: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>,
    award: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>,
    checkCircle: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>,
    alertCircle: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>,
    mail: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>,
    phone: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>,
    upload: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>,
    filter: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>,
    layers: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>,
    eye: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"></path><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>,
    chevronRight: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7"></path></svg>,
    beer: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 11h1a3 3 0 0 1 0 6h-1"></path><path d="M9 12v6"></path><path d="M13 12v6"></path><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2.5 11 2.5s2 .5 3 .5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"></path><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"></path></svg>,
    wine: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 22h8"></path><path d="M12 11v11"></path><path d="M5 3l7 8 7-8"></path><path d="M5 3v5c0 2.4 2.8 5 7 5s7-2.6 7-5V3"></path></svg>,
    laugh: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>,
    gamepad: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line><rect x="2" y="6" width="20" height="12" rx="2"></rect></svg>,
    palette: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r="1.5"></circle><circle cx="17.5" cy="10.5" r="1.5"></circle><circle cx="8.5" cy="7.5" r="1.5"></circle><circle cx="6.5" cy="12.5" r="1.5"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"></path></svg>,
    coffee: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 8h1a4 4 0 1 1 0 8h-1"></path><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"></path><line x1="6" y1="2" x2="6" y2="4"></line><line x1="10" y1="2" x2="10" y2="4"></line><line x1="14" y1="2" x2="14" y2="4"></line></svg>,
    partyPopper: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5.8 11.3 2 22l10.7-3.79"></path><path d="M4 3h.01"></path><path d="M22 8h.01"></path><path d="M15 2h.01"></path><path d="M22 20h.01"></path><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12v0c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"></path><path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11v0c-.11.7-.72 1.22-1.43 1.22H17"></path><path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98v0C9.52 4.9 9 5.52 9 6.23V7"></path><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"></path></svg>,
    externalLink: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>,
    fileText: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>,
    moreVertical: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>,
    doorOpen: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 4h3a2 2 0 0 1 2 2v14"></path><path d="M2 20h3"></path><path d="M13 20h9"></path><path d="M10 12v.01"></path><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"></path></svg>,
    pin: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>,
    pinFilled: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>,
    chevronUp: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6"></path></svg>,
    chevronDown: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"></path></svg>,
    gripVertical: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>,
  };

  // Activity feed
  const activityFeed = [
    { id: 1, icon: Icons.plus(colors.teal, 14), user: 'Mike Rodriguez', action: 'created', target: 'Weekend Brunch Crew', time: '2h ago' },
    { id: 2, icon: Icons.users(colors.navyMid, 14), user: 'Emma Taylor', action: 'joined', target: 'Friday Night Out', time: '5h ago' },
    { id: 3, icon: Icons.check(colors.sports, 14), user: 'Jayden Bansal', action: 'confirmed', target: 'DECA Nationals Prep', time: '8h ago' },
  ];

  // Add reaction to message
  const addReactionToMessage = useCallback((flockId, messageId, reaction) => {
    setFlocks(prev => prev.map(f => {
      if (f.id === flockId) {
        return {
          ...f,
          messages: f.messages.map(m => {
            if (m.id === messageId) {
              const hasReaction = m.reactions.includes(reaction);
              return { ...m, reactions: hasReaction ? m.reactions.filter(r => r !== reaction) : [...m.reactions, reaction] };
            }
            return m;
          })
        };
      }
      return f;
    }));
    setShowReactionPicker(null);
  }, []);

  // Simulate typing indicator with user name
  // Typing indicators now driven by real WebSocket events
  const simulateTyping = useCallback(() => {}, []);

  // Share venue to chat
  const shareVenueToChat = useCallback(async (flockId, venue) => {
    const venueData = {
      place_id: venue.place_id || null,
      name: venue.name,
      type: venue.type,
      category: venue.category,
      addr: venue.addr,
      stars: venue.stars,
      rating: venue.rating || venue.stars || null,
      price: venue.price,
      price_level: venue.price_level || null,
      crowd: venue.crowd,
      best: venue.best,
      photo_url: venue.photo_url || null,
      lat: venue.location?.latitude || null,
      lng: venue.location?.longitude || null,
    };
    const msgText = `Check out ${venue.name}!`;

    // Optimistic local update
    addMessageToFlock(flockId, {
      id: Date.now(),
      sender: authUser?.name || 'You',
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      text: msgText,
      reactions: [],
      message_type: 'venue_card',
      venue_data: venueData,
    });

    // Send via socket (instant) + HTTP (persistent)
    socketSendMessage(flockId, msgText, { message_type: 'venue_card', venue_data: venueData });
    try {
      await apiSendMessage(flockId, msgText, { message_type: 'venue_card', venue_data: venueData });
    } catch {}

    setShowVenueShareModal(false);
    // Toast removed — card appears in chat
    addXP(5);
  }, [addMessageToFlock, addXP, authUser]);

  // Share image to chat
  const shareImageToChat = useCallback((flockId) => {
    if (!pendingImage) return;
    const imageMessage = {
      id: Date.now(),
      sender: 'You',
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      text: '',
      reactions: [],
      image: pendingImage
    };
    addMessageToFlock(flockId, imageMessage);

    // Broadcast via WebSocket so other users see it in real-time
    socketSendImage(flockId, pendingImage);

    setPendingImage(null);
    setShowImagePreview(false);
    // Toast removed — image appears in chat
    addXP(5);
  }, [pendingImage, addMessageToFlock, addXP]);

  // Handle image selection
  const handleChatImageSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => { setPendingImage(reader.result); setShowImagePreview(true); };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, [showToast]);

  // Camera viewfinder handlers
  const openCameraViewfinder = useCallback(async (source) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Camera not supported in this browser', 'error');
      return;
    }
    setShowCameraViewfinder(source); // 'flock' or 'dm'
    setShowCameraPopup(false);
    setShowDmCameraPopup(false);
    setTimeout(async () => {
      try {
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        } catch {
          // Fallback — any camera
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        cameraStreamRef.current = stream;
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
          await cameraVideoRef.current.play();
        }
      } catch (err) {
        console.error('Camera access error:', err);
        showToast(err.name === 'NotAllowedError' ? 'Camera permission denied — allow it in browser settings' : 'Could not access camera: ' + (err.message || err.name), 'error');
        setShowCameraViewfinder(null);
      }
    }, 300);
  }, [showToast]);

  const closeCameraViewfinder = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(t => t.stop());
      cameraStreamRef.current = null;
    }
    setShowCameraViewfinder(null);
  }, []);

  const capturePhoto = useCallback(() => {
    const video = cameraVideoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const source = showCameraViewfinder;
    closeCameraViewfinder();
    if (source === 'flock') {
      setPendingImage(dataUrl);
      setShowImagePreview(true);
    } else if (source === 'dm') {
      setDmPendingImage(dataUrl);
      setShowDmImagePreview(true);
    }
  }, [showCameraViewfinder, closeCameraViewfinder]);

  const handlePhotoUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => { setProfilePic(reader.result); setShowPicModal(false); addXP(10); };
      reader.readAsDataURL(file);
    }
  }, [addXP]);

  const generateAIAvatar = useCallback(() => {
    const styles = ['adventurer', 'avataaars', 'bottts', 'personas', 'pixel-art'];
    const style = styles[Math.floor(Math.random() * styles.length)];
    const seed = Math.random().toString(36).substring(7);
    setProfilePic(`https://api.dicebear.com/7.x/${style}/svg?seed=${seed}`);
    setShowPicModal(false);
    // Toast removed — avatar updates visually
    addXP(10);
  }, [addXP]);

  // Toggle Component
  const Toggle = ({ on, onChange }) => (
    <button onClick={onChange} style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', backgroundColor: on ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative', transition: 'background-color 0.2s' }}>
      <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: 'white', position: 'absolute', top: '2px', left: on ? '22px' : '2px', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
    </button>
  );

  // SVG Icons for navigation
  const NavIcon = ({ id, active }) => {
    const color = active ? colors.navy : '#9ca3af';
    const icons = {
      home: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>,
      explore: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>,
      calendar: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>,
      chat: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>,
      revenue: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>,
      profile: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    };
    return icons[id] || null;
  };

  // Bottom Navigation (Regular users only - hidden in admin/venue modes)
  const BottomNav = () => {
    // Hide bottom nav for admin and venue modes
    if (userMode === 'admin' || userMode === 'venue') return null;

    const handleTabClick = (tabId) => {
      setActiveTabAnimation(tabId);
      setTimeout(() => setActiveTabAnimation(null), 400);
      setCurrentTab(tabId);
      setCurrentScreen('main');
      setProfileScreen('main');
      setActiveVenue(null);
      setShowConnectPanel(false);
      // Auto-load venues when switching to Discover
      if (tabId === 'explore' && (!mapVenuesLoaded || !userLocation)) {
        requestUserLocation();
      }
    };

    return (
      <div style={{
        ...styles.bottomNav,
        boxShadow: '0 -4px 24px rgba(0,0,0,0.06)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        backgroundColor: 'rgba(255,255,255,0.95)',
        borderTop: '1px solid rgba(0,0,0,0.03)',
        padding: '10px 8px 12px'
      }}>
        {[
          { id: 'home', label: 'Nest' },
          { id: 'explore', label: 'Discover' },
          { id: 'calendar', label: 'Plans' },
          { id: 'chat', label: 'Messages' },
          { id: 'profile', label: 'You' },
        ].map(t => (
          <button key={t.id} onClick={() => handleTabClick(t.id)}
            style={{
              ...styles.navItem,
              backgroundColor: currentTab === t.id ? colors.cream : 'transparent',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              transform: currentTab === t.id ? 'scale(1.05)' : 'scale(1)',
              borderRadius: '14px',
              padding: '8px 14px'
            }}>
            <div className={activeTabAnimation === t.id ? 'tab-bounce' : ''} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transition: 'all 0.2s ease' }}>
              <div style={{
                transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                transform: currentTab === t.id ? 'scale(1.1)' : 'scale(1)'
              }}>
                <NavIcon id={t.id} active={currentTab === t.id} />
              </div>
              <span style={{
                fontSize: '10px',
                fontWeight: currentTab === t.id ? '700' : '500',
                color: currentTab === t.id ? colors.navy : '#94a3b8',
                marginTop: '3px',
                transition: 'all 0.2s ease'
              }}>{t.label}</span>
              {currentTab === t.id && (
                <div style={{
                  width: '4px',
                  height: '4px',
                  borderRadius: '2px',
                  backgroundColor: colors.navy,
                  marginTop: '3px',
                  animation: 'scaleBounceIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
                }} />
              )}
            </div>
          </button>
        ))}
      </div>
    );
  };

  // --- Safety handlers ---
  const loadTrustedContacts = useCallback(async () => {
    try {
      setSafetyLoading(true);
      const data = await getTrustedContacts();
      setTrustedContacts(data.contacts || []);
    } catch (err) {
      console.warn('Failed to load trusted contacts:', err);
    } finally {
      setSafetyLoading(false);
    }
  }, []);

  const handleEditContact = useCallback((contact) => {
    setEditingContact(contact);
    setNewContact({ name: contact.contact_name, phone: contact.contact_phone, email: contact.contact_email || '', relationship: contact.relationship || '' });
    setShowAddContact(true);
  }, []);

  const handleSaveContact = useCallback(async () => {
    if (!newContact.name.trim() || !newContact.phone.trim()) {
      showToast('Name and phone are required', 'error');
      return;
    }
    if (!newContact.email.trim()) {
      showToast('Email is required to send alerts', 'error');
      return;
    }
    try {
      setSafetyLoading(true);
      if (editingContact) {
        await updateTrustedContact(editingContact.id, newContact);
        showToast('Contact updated');
      } else {
        await addTrustedContact(newContact);
        showToast('Trusted contact added');
      }
      setNewContact({ name: '', phone: '', email: '', relationship: '' });
      setShowAddContact(false);
      setEditingContact(null);
      loadTrustedContacts();
    } catch (err) {
      showToast(err.message || 'Failed to save contact', 'error');
    } finally {
      setSafetyLoading(false);
    }
  }, [newContact, editingContact, showToast, loadTrustedContacts]);

  const handleDeleteContact = useCallback(async (contactId) => {
    try {
      await deleteTrustedContact(contactId);
      setTrustedContacts(prev => prev.filter(c => c.id !== contactId));
      showToast('Contact removed');
    } catch (err) {
      showToast('Failed to remove contact', 'error');
    }
  }, [showToast]);

  const handleEmergencyAlert = useCallback(async () => {
    if (trustedContacts.length === 0) {
      showToast('Add trusted contacts in Safety settings first', 'error');
      return;
    }
    setSosAlertSending(true);
    try {
      const getPos = () => new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
          (err) => { console.warn('[Emergency] Location error:', err.message); resolve(null); },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
        );
      });
      const loc = navigator.geolocation ? await getPos() : null;
      const data = await sendEmergencyAlert({
        latitude: loc?.latitude,
        longitude: loc?.longitude,
        includeLocation: !!loc,
      });
      showToast(data.message || 'Emergency alert sent');
      setShowSOS(false);
    } catch (err) {
      showToast(err.message || 'Failed to send alert', 'error');
    } finally {
      setSosAlertSending(false);
    }
  }, [trustedContacts, showToast]);

  const handleShareLocationWithContacts = useCallback(async () => {
    if (trustedContacts.length === 0) {
      showToast('Add trusted contacts in Safety settings first', 'error');
      return;
    }
    if (!navigator.geolocation) {
      showToast('Location not supported', 'error');
      return;
    }
    setSosAlertSending(true);
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
      });
      const data = await shareLocationWithContacts({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      showToast(data.message || 'Location shared');
      setShowSOS(false);
    } catch (err) {
      if (err.code) {
        showToast('Could not get location — check permissions', 'error');
      } else {
        showToast(err.message || 'Failed to share location', 'error');
      }
    } finally {
      setSosAlertSending(false);
    }
  }, [trustedContacts, showToast]);

  // Safety Button - Enhanced with pulse animation
  const SafetyButton = () => safetyOn && currentScreen === 'main' && !showSOS && (
    <button
      onClick={() => { setShowSOS(true); getTrustedContacts().then(d => setTrustedContacts(d.contacts || [])).catch(() => {}); }}
      style={{
        position: 'absolute',
        bottom: '75px',
        right: '12px',
        width: '52px',
        height: '52px',
        borderRadius: '26px',
        border: 'none',
        background: `linear-gradient(135deg, ${colors.red}, #f97316)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(239,68,68,0.4), 0 2px 6px rgba(0,0,0,0.1)',
        zIndex: 20,
        animation: 'breathe 3s ease-in-out infinite',
        transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
      }}
    >
      {Icons.shield('white', 24)}
    </button>
  );

  // AI Button - Enhanced with floating animation
  const AIButton = () => currentScreen === 'main' && currentTab === 'home' && (
    <button
      onClick={() => setShowAiAssistant(true)}
      style={{
        position: 'absolute',
        bottom: '75px',
        left: '12px',
        width: '52px',
        height: '52px',
        borderRadius: '26px',
        border: 'none',
        background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(13,40,71,0.35), 0 2px 6px rgba(0,0,0,0.1)',
        zIndex: 20,
        animation: 'float 4s ease-in-out infinite',
        transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
      }}
    >
      <div style={{ animation: 'breathe 2s ease-in-out infinite' }}>
        {Icons.robot('white', 24)}
      </div>
    </button>
  );

  // Toast — lightweight, GPU-accelerated
  const Toast = () => toast && (
    <div style={{
      position: 'fixed',
      top: '50px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 60,
      padding: '12px 24px',
      borderRadius: '24px',
      backgroundColor: toast.type === 'error' ? colors.red : colors.navy,
      color: 'white',
      fontSize: '13px',
      fontWeight: '700',
      boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      willChange: 'transform, opacity',
    }}>
      {toast.message}
    </div>
  );


  // SOS Modal
  const SOSModal = () => showSOS && (
    <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '24px', padding: '24px', width: '100%', maxWidth: '300px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '32px', backgroundColor: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>{Icons.bell(colors.red, 32)}</div>
          <h2 style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: '0 0 4px' }}>Emergency</h2>
          <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>{trustedContacts.length > 0 ? `${trustedContacts.length} trusted contact${trustedContacts.length > 1 ? 's' : ''} will be notified` : 'No trusted contacts set up'}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button disabled={sosAlertSending} onClick={handleEmergencyAlert} style={{ ...styles.gradientButton, background: `linear-gradient(90deg, ${colors.red}, #f97316)`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', position: 'relative', overflow: 'hidden', opacity: sosAlertSending ? 0.6 : 1 }}>{Icons.shield('white', 16)} {sosAlertSending ? 'Sending...' : 'Alert Contacts'}</button>
          <button disabled={sosAlertSending} onClick={handleShareLocationWithContacts} style={{ ...styles.gradientButton, background: 'white', color: colors.navy, border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', opacity: sosAlertSending ? 0.6 : 1 }}>{Icons.mapPin(colors.navy, 16)} {sosAlertSending ? 'Sending...' : 'Share Location'}</button>
          {trustedContacts.length === 0 && (
            <button onClick={() => { setShowSOS(false); setProfileScreen('safety'); setCurrentScreen('profile'); loadTrustedContacts(); }} style={{ ...styles.gradientButton, background: colors.cream, color: colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '13px' }}>Set Up Trusted Contacts</button>
          )}
          <button disabled={sosAlertSending} onClick={() => setShowSOS(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );

  // Check-in Modal
  const CheckinModal = () => showCheckin && (
    <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '32px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>{Icons.check(colors.teal, 32)}</div>
          <h2 style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>Check-in</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={(e) => { confirmClick(e); setShowCheckin(false); addXP(30); }} style={{ ...styles.gradientButton, backgroundColor: colors.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', position: 'relative', overflow: 'hidden' }}>{Icons.check('white', 16)} I'm Safe</button>
          <button onClick={() => { setShowCheckin(false); setShowSOS(true); }} style={{ ...styles.gradientButton, backgroundColor: colors.red, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.shield('white', 16)} Need Help</button>
          <button onClick={() => setShowCheckin(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Dismiss</button>
        </div>
      </div>
    </div>
  );

  // Profile Pic Modal
  const ProfilePicModal = () => showPicModal && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Profile Picture</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ ...styles.gradientButton, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', cursor: 'pointer' }}>
            {Icons.camera('white', 16)} Upload Photo
            <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: 'none' }} />
          </label>
          <button onClick={generateAIAvatar} style={{ ...styles.gradientButton, background: 'white', color: colors.navy, border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.robot(colors.navy, 16)} Generate AI Avatar</button>
          <button onClick={() => setShowPicModal(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );

  // Handler for admin mode — verified via user role from backend
  const handleAdminModeSelect = () => {
    if (authUser?.role === 'admin') {
      localStorage.setItem('flockUserMode', 'admin');
      setUserMode('admin');
      setShowModeSelection(false);
      setShowAdminPrompt(false);
      setCurrentScreen('adminRevenue');
    } else {
      showToast('Admin access denied', 'error');
      setShowAdminPrompt(false);
    }
  };

  // Admin Access Modal - role-based, no password needed
  const adminPromptModal = showAdminPrompt && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>
            {Icons.shield(colors.navy, 24)}
          </div>
          <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Admin Access</h2>
          <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0' }}>{authUser?.role === 'admin' ? 'Switch to admin mode?' : 'Admin access is restricted'}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setShowAdminPrompt(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
          {authUser?.role === 'admin' && (
            <button onClick={handleAdminModeSelect} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', cursor: 'pointer' }}>Access</button>
          )}
        </div>
      </div>
    </div>
  );

  // New DM Modal - Friend Selector (searches real users via API)
  const [dmModalResults, setDmModalResults] = useState([]);
  const [dmModalSearching, setDmModalSearching] = useState(false);
  const dmModalTimerRef = useRef(null);

  const handleDmSearch = useCallback((val) => {
    setDmSearchText(val);
    if (dmModalTimerRef.current) clearTimeout(dmModalTimerRef.current);
    if (val.trim().length < 1) { setDmModalResults([]); return; }
    setDmModalSearching(true);
    dmModalTimerRef.current = setTimeout(async () => {
      try {
        const data = await searchUsers(val.trim());
        setDmModalResults(data.users || []);
      } catch { setDmModalResults([]); }
      finally { setDmModalSearching(false); }
    }, 400);
  }, []);

  // Load suggested users when DM modal opens
  useEffect(() => {
    if (showNewDmModal && suggestedUsers.length === 0) loadSuggestedUsers();
  }, [showNewDmModal, suggestedUsers.length, loadSuggestedUsers]);

  const startNewDmWithUser = useCallback((user) => {
    // Find existing DM by user ID or create a new local entry
    const existingDm = directMessages.find(dm => dm.userId === user.id);
    if (existingDm) {
      setSelectedDmId(existingDm.userId);
    } else {
      // Auto-send friend request when starting a new DM
      sendFriendRequest(user.id).catch(() => {});
      // Un-delete if previously deleted
      if (deletedDmUserIds.includes(user.id)) {
        const updated = deletedDmUserIds.filter(id => id !== user.id);
        setDeletedDmUserIds(updated);
        try { localStorage.setItem('flock_deleted_dms', JSON.stringify(updated)); } catch {}
      }
      const newDm = {
        userId: user.id,
        name: user.name,
        image: user.profile_image_url || null,
        messages: [],
        lastMessage: null,
        unread: 0,
      };
      setDirectMessages(prev => [newDm, ...prev]);
      setSelectedDmId(user.id);
    }
    setShowNewDmModal(false);
    setDmSearchText('');
    setDmModalResults([]);
    setCurrentScreen('dmDetail');
  }, [directMessages, deletedDmUserIds]);

  const NewDmModal = () => {
    const usersToShow = dmSearchText.trim() ? dmModalResults : suggestedUsers;

    return showNewDmModal && (
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
        <div style={{ backgroundColor: 'white', borderRadius: '24px 24px 0 0', width: '100%', height: '70%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>New Message</h2>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Search for someone to message</p>
            </div>
            <button onClick={() => { setShowNewDmModal(false); setDmSearchText(''); setDmModalResults([]); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: colors.cream, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.x(colors.navy, 16)}
            </button>
          </div>
          <div style={{ padding: '12px' }}>
            <input type="text" value={dmSearchText} onChange={(e) => handleDmSearch(e.target.value)} placeholder="Search by name or email..." style={{ width: '100%', padding: '12px 16px', borderRadius: '12px', border: `1.5px solid ${dmSearchText ? colors.navy : colors.creamDark}`, fontSize: '14px', outline: 'none', boxSizing: 'border-box', backgroundColor: '#f8fafc', fontWeight: '500', transition: 'all 0.2s ease' }} autoComplete="off" />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
            {!dmSearchText.trim() && usersToShow.length > 0 && (
              <p style={{ fontSize: '10px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 4px 8px', margin: 0 }}>Suggested</p>
            )}
            {dmModalSearching && (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ display: 'inline-block', width: '18px', height: '18px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '8px' }}>Searching...</span>
              </div>
            )}
            {!dmModalSearching && usersToShow.length === 0 && dmSearchText.trim() && (
              <div style={{ textAlign: 'center', padding: '24px', color: '#6b7280' }}>
                <p style={{ fontSize: '13px', margin: 0 }}>No users found for "{dmSearchText}"</p>
              </div>
            )}
            {!dmModalSearching && usersToShow.length === 0 && !dmSearchText.trim() && (
              <div style={{ textAlign: 'center', padding: '24px', color: '#6b7280' }}>
                <p style={{ fontSize: '13px', margin: 0 }}>Type a name to find people</p>
              </div>
            )}
            {!dmModalSearching && usersToShow.map(user => (
              <button key={user.id} onClick={() => startNewDmWithUser(user)} style={{ width: '100%', textAlign: 'left', padding: '10px 8px', borderRadius: '12px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px', transition: 'background-color 0.15s' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = colors.cream; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <div style={{ width: '44px', height: '44px', borderRadius: '22px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                  {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: '14px', fontWeight: '700', color: colors.navy, margin: 0 }}>{user.name}</h3>
                  <p style={{ fontSize: '11px', color: '#6b7280', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</p>
                </div>
                <span style={{ fontSize: '16px', color: '#9ca3af' }}>›</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // DM Detail Screen - Inline JSX to prevent focus loss on input
  const selectedDm = directMessages.find(d => d.userId === selectedDmId);

  // Load DM conversations from backend on mount (filter out deleted ones)
  useEffect(() => {
    getDMConversations()
      .then(data => {
        const hidden = deletedDmUserIds;
        setDirectMessages((data.conversations || []).filter(c => !hidden.includes(c.userId)).map(c => ({
          userId: c.userId,
          name: c.name,
          image: c.image,
          messages: [],
          lastMessage: c.lastMessage,
          lastMessageTime: c.lastMessageTime,
          lastMessageIsYou: c.lastMessageIsYou,
          unread: c.unread,
        })));
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load messages when opening a DM conversation
  useEffect(() => {
    if (currentScreen === 'dmDetail' && selectedDmId) {
      getDMs(selectedDmId)
        .then(data => {
          const msgs = (data.messages || []).map(m => ({
            id: m.id,
            sender: m.sender_id === authUser?.id ? 'You' : (m.sender_name || 'Unknown'),
            senderId: m.sender_id,
            text: m.message_text,
            time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            message_type: m.message_type || 'text',
            venue_data: m.venue_data,
            image_url: m.image_url,
            reactions: m.reactions || [],
            reply_to: m.reply_to ? { id: m.reply_to.id, text: m.reply_to.message_text, sender: m.reply_to.sender_name } : null,
          }));
          setDirectMessages(prev => prev.map(d => d.userId === selectedDmId ? { ...d, messages: msgs, unread: 0 } : d));
        })
        .catch(() => {});
      // Load venue votes for this conversation
      getDmVenueVotes(selectedDmId).then(data => setDmVenueVotes(data.votes || [])).catch(() => {});
      // Load pinned venue for this conversation
      getDmPinnedVenue(selectedDmId).then(data => {
        if (data.venue) setDmPinnedVenue({ name: data.venue.venue_name, addr: data.venue.venue_address, place_id: data.venue.venue_id, rating: data.venue.venue_rating, photo_url: data.venue.venue_photo_url });
        else setDmPinnedVenue(null);
      }).catch(() => {});
    }
  }, [currentScreen, selectedDmId, authUser]);

  const sendDmMessage = useCallback((opts = {}) => {
    const text = (opts.text || chatInput).trim();
    const msgType = opts.message_type || 'text';
    if (!text && msgType !== 'image') return;
    if (!selectedDm) return;
    if (!opts.text) setChatInput('');
    // Stop typing indicator
    if (dmTypingTimeoutRef.current) {
      clearTimeout(dmTypingTimeoutRef.current);
      dmStopTyping(selectedDmId);
    }
    // Clear reply
    const replyTo = opts.reply_to_id ? dmReplyingTo : dmReplyingTo;
    if (!opts.noReply) setDmReplyingTo(null);
    // Optimistic update — show message instantly
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      sender: 'You',
      senderId: authUser?.id,
      text: text || (msgType === 'image' ? '📷 Photo' : ''),
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      message_type: msgType,
      venue_data: opts.venue_data || null,
      image_url: opts.image_url || null,
      reactions: [],
      reply_to: replyTo && !opts.noReply ? { id: replyTo.id, text: replyTo.text, sender: replyTo.sender } : null,
    };
    setDirectMessages(prev => prev.map(d => d.userId === selectedDmId ? { ...d, messages: [...d.messages, optimistic], lastMessage: text || '📷 Photo', lastMessageIsYou: true } : d));
    socketSendDm(selectedDmId, text || '', {
      message_type: msgType,
      venue_data: opts.venue_data,
      image_url: opts.image_url,
      reply_to_id: replyTo && !opts.noReply ? replyTo.id : null,
    });
  }, [chatInput, selectedDm, selectedDmId, dmReplyingTo, authUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for real-time DMs
  useEffect(() => {
    const unsub = onNewDm((msg) => {
      const otherUserId = msg.sender_id === authUser?.id ? msg.receiver_id : msg.sender_id;
      const isYou = msg.sender_id === authUser?.id;
      const mapped = {
        id: msg.id,
        sender: isYou ? 'You' : (msg.sender_name || 'Unknown'),
        senderId: msg.sender_id,
        text: msg.message_text,
        time: new Date(msg.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        message_type: msg.message_type || 'text',
        venue_data: msg.venue_data,
        image_url: msg.image_url,
        reactions: msg.reactions || [],
        reply_to: msg.reply_to || null,
      };
      const previewText = msg.message_type === 'image' ? '📷 Photo' : msg.message_type === 'venue_card' ? '📍 Venue' : msg.message_text;
      setDirectMessages(prev => {
        const existing = prev.find(d => d.userId === otherUserId);
        if (existing) {
          return prev.map(d => {
            if (d.userId !== otherUserId) return d;
            if (d.messages.some(m => m.id === msg.id)) return d;
            // If own message, replace the optimistic temp message
            if (isYou) {
              const tempIdx = d.messages.findIndex(m => typeof m.id === 'string' && m.id.startsWith('temp-') && m.text === msg.message_text);
              if (tempIdx !== -1) {
                const updated = [...d.messages];
                updated[tempIdx] = mapped;
                return { ...d, messages: updated, lastMessageTime: msg.created_at };
              }
            }
            return { ...d, messages: [...d.messages, mapped], lastMessage: previewText, lastMessageIsYou: isYou, lastMessageTime: msg.created_at, unread: isYou ? d.unread : d.unread + 1 };
          });
        }
        return [{
          userId: otherUserId,
          name: msg.sender_name || 'Unknown',
          image: null,
          messages: [mapped],
          lastMessage: previewText,
          lastMessageTime: msg.created_at,
          lastMessageIsYou: isYou,
          unread: isYou ? 0 : 1,
        }, ...prev];
      });
    });
    return unsub;
  }, [authUser]);

  // Listen for DM reactions in real-time
  useEffect(() => {
    const unsubAdd = onDmReactionAdded((data) => {
      setDirectMessages(prev => prev.map(d => ({
        ...d,
        messages: d.messages.map(m => {
          if (m.id !== data.dmId) return m;
          const exists = (m.reactions || []).some(r => r.emoji === data.emoji && r.user_id === data.userId);
          if (exists) return m;
          return { ...m, reactions: [...(m.reactions || []), { emoji: data.emoji, user_id: data.userId, user_name: data.userName }] };
        }),
      })));
    });
    const unsubRemove = onDmReactionRemoved((data) => {
      setDirectMessages(prev => prev.map(d => ({
        ...d,
        messages: d.messages.map(m => {
          if (m.id !== data.dmId) return m;
          return { ...m, reactions: (m.reactions || []).filter(r => !(r.emoji === data.emoji && r.user_id === data.userId)) };
        }),
      })));
    });
    return () => { unsubAdd(); unsubRemove(); };
  }, []);

  // Listen for DM venue votes in real-time
  useEffect(() => {
    const unsub = onDmNewVote((data) => {
      setDmVenueVotes(data.votes || []);
    });
    return unsub;
  }, []);

  // DM location sharing
  useEffect(() => {
    const unsubLoc = onDmLocationUpdate((data) => {
      setDmMemberLocation({ lat: data.lat, lng: data.lng, name: data.name, timestamp: data.timestamp });
    });
    const unsubStop = onDmMemberStoppedSharing(() => {
      setDmMemberLocation(null);
    });
    return () => { unsubLoc(); unsubStop(); };
  }, []);

  // DM pinned venue real-time sync
  useEffect(() => {
    const unsub = onDmVenuePinned((data) => {
      setDmPinnedVenue({ name: data.venue_name, addr: data.venue_address, place_id: data.venue_id, rating: data.venue_rating, photo_url: data.venue_photo_url });
    });
    return unsub;
  }, []);

  // Emit DM location periodically when sharing
  useEffect(() => {
    if (!dmSharingLocation || !userLocation) return;
    const interval = setInterval(() => {
      dmShareLocation(dmSharingLocation, userLocation.lat, userLocation.lng);
    }, 10000);
    dmShareLocation(dmSharingLocation, userLocation.lat, userLocation.lng);
    return () => clearInterval(interval);
  }, [dmSharingLocation, userLocation]);

  // DM typing indicators
  useEffect(() => {
    const unsubTyping = onDmUserTyping((data) => {
      if (data.userId === selectedDmId) {
        setDmTypingUser(data.name);
        setDmIsTyping(true);
      }
    });
    const unsubStop = onDmUserStoppedTyping((data) => {
      if (data.userId === selectedDmId) {
        setDmIsTyping(false);
        setDmTypingUser('');
      }
    });
    return () => { unsubTyping(); unsubStop(); };
  }, [selectedDmId]);

  // DM input change with typing indicator
  const handleDmInputChange = useCallback((e) => {
    setChatInput(e.target.value);
    if (selectedDmId) {
      dmStartTyping(selectedDmId);
      clearTimeout(dmTypingTimeoutRef.current);
      dmTypingTimeoutRef.current = setTimeout(() => {
        dmStopTyping(selectedDmId);
      }, 2000);
    }
  }, [selectedDmId]);

  // Auto-scroll DM chat to bottom
  useEffect(() => {
    if (currentScreen === 'dmDetail' && selectedDm?.messages?.length) {
      setTimeout(() => dmChatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [currentScreen, selectedDm?.messages?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep DM chat search focused
  useEffect(() => {
    if (showDmChatSearch && dmChatSearchRef.current) dmChatSearchRef.current.focus();
  }, [showDmChatSearch, dmChatSearch]);

  // DM venue search with debounce

  // DM image handler
  const handleDmImageSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => { setDmPendingImage(reader.result); setShowDmImagePreview(true); };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, [showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const dmReactions = ['❤️', '👍', '😂', '🔥'];

  const dmDetailScreen = currentScreen === 'dmDetail' && selectedDm && (
    <div key="dm-detail-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
      {/* Header */}
      <div style={{ padding: '6px 10px 5px 4px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button onClick={() => { setCurrentScreen('main'); setChatInput(''); setShowDmMenu(false); setShowDeleteDmConfirm(false); setShowDmChatSearch(false); setDmChatSearch(''); setShowDmVotePanel(false); setShowDmVenueSearch(false); setDmReplyingTo(null); if (dmSharingLocation) { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); } }} style={{ width: '34px', height: '34px', borderRadius: '17px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.arrowLeft('white', 20)}</button>
          <div style={{ width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: '700', color: 'white', overflow: 'hidden', flexShrink: 0 }}>
            {selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '34px', height: '34px', borderRadius: '17px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?')}
          </div>
          <h2 style={{ flex: 1, fontWeight: '800', color: 'white', fontSize: '15px', margin: 0, lineHeight: '1.3', minWidth: 0 }}>{selectedDm.name}</h2>
          <button onClick={() => { setShowDmVotePanel(!showDmVotePanel); if (!showDmVotePanel) loadPopularVenues(); }} style={{ height: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '0 12px', fontSize: '12px', fontWeight: '700', flexShrink: 0 }}>{Icons.vote('white', 14)} Vote</button>
          <button onClick={() => setShowDmChatSearch(!showDmChatSearch)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: showDmChatSearch ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.search('white', 15)}</button>
          <button onClick={() => setShowDmCashPool(true)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: colors.cream, color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.dollar(colors.navy, 15)}</button>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setShowDmMenu(!showDmMenu)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.moreVertical('white', 16)}</button>
            {showDmMenu && (
              <div style={{ position: 'absolute', top: '38px', right: 0, backgroundColor: 'white', borderRadius: '14px', boxShadow: '0 8px 30px rgba(0,0,0,0.18)', minWidth: '200px', zIndex: 60, overflow: 'hidden', border: '1px solid rgba(0,0,0,0.06)' }}>
                <button onClick={() => { setShowDmMenu(false); setShowDeleteDmConfirm(true); }} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', backgroundColor: 'white', cursor: 'pointer', fontSize: '14px', fontWeight: '600', color: '#EF4444' }}>
                  {Icons.x('#EF4444', 16)} Delete Conversation
                </button>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', paddingLeft: '74px', marginTop: '2px' }}>
          {dmIsTyping ? <span style={{ fontSize: '11px', color: '#86EFAC', fontWeight: '600' }}>{dmTypingUser || selectedDm.name} is typing...</span> : dmSharingLocation ? <span style={{ fontSize: '11px', color: '#34d399', fontWeight: '600' }}>📍 sharing location</span> : <><span style={{ width: '5px', height: '5px', borderRadius: '3px', backgroundColor: '#22c55e', boxShadow: '0 0 6px #22c55e' }} /><span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>online</span></>}
        </div>
      </div>

      {/* Dismiss DM menu */}
      {showDmMenu && <div onClick={() => setShowDmMenu(false)} style={{ position: 'absolute', inset: 0, zIndex: 55 }} />}

      {/* Chat search bar */}
      {showDmChatSearch && (
        <div style={{ padding: '8px 12px', backgroundColor: 'white', borderBottom: '1px solid #eee', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
          <input ref={dmChatSearchRef} type="text" value={dmChatSearch} onChange={(e) => setDmChatSearch(e.target.value)} placeholder="Search messages..." style={{ flex: 1, padding: '8px 12px', borderRadius: '20px', backgroundColor: '#f3f4f6', border: 'none', fontSize: '13px', outline: 'none' }} />
          {dmChatSearch && <button onClick={() => setDmChatSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#6b7280', 14)}</button>}
        </div>
      )}

      {/* Location sharing indicator */}
      {dmSharingLocation && (
        <div style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #059669, #047857)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#34d399', animation: 'pulse 2s ease-in-out infinite', boxShadow: '0 0 6px #34d399' }} />
          <p style={{ fontSize: '11px', fontWeight: '600', color: 'white', margin: 0, flex: 1 }}>Sharing live location with {selectedDm.name}</p>
          {dmMemberLocation && <span style={{ fontSize: '10px', color: '#a7f3d0', fontWeight: '500' }}>{selectedDm.name} sharing too</span>}
          <button onClick={() => { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); }} style={{ padding: '4px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: '10px', fontWeight: '600', cursor: 'pointer' }}>Stop</button>
        </div>
      )}

      {/* Pinned Venue Banner — top-voted or manually pinned venue */}
      {dmPinnedVenue ? (
        <div style={{ padding: '10px 14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.teal}12)`, borderBottom: `1px solid ${colors.creamDark}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {dmPinnedVenue.photo_url ? (
              <img src={dmPinnedVenue.photo_url} alt="" style={{ width: '52px', height: '52px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52"><rect fill="#1a3a5c" width="52" height="52" rx="12"/></svg>'); }} />
            ) : (
              <div style={{ width: '52px', height: '52px', borderRadius: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.2)' }}>
                {Icons.mapPin('white', 22)}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <h4 style={{ fontSize: '13px', fontWeight: '800', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.name}</h4>
                {dmPinnedVenue.rating && <span style={{ fontSize: '11px', fontWeight: '700', color: '#F59E0B', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>{Icons.starFilled('#F59E0B', 11)} {dmPinnedVenue.rating}</span>}
              </div>
              {dmPinnedVenue.addr && <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.addr}</p>}
            </div>
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
              <button
                onClick={() => {
                  setCurrentTab('explore');
                  setCurrentScreen('main');
                  if (dmPinnedVenue.place_id) {
                    setTimeout(() => {
                      if (window.__flockPanToVenue) {
                        window.__flockPanToVenue({ place_id: dmPinnedVenue.place_id, name: dmPinnedVenue.name, address: dmPinnedVenue.addr, rating: dmPinnedVenue.rating, photo_url: dmPinnedVenue.photo_url });
                      }
                    }, 300);
                  }
                }}
                style={{ padding: '8px 10px', borderRadius: '10px', border: 'none', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, color: 'white', fontSize: '10px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', boxShadow: '0 2px 8px rgba(20,184,166,0.3)' }}
              >
                {Icons.mapPin('white', 12)} Map
              </button>
              <button onClick={() => { setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ padding: '8px 10px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, background: 'white', color: colors.navy, fontSize: '10px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px' }}>
                Change
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button onClick={() => { setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ margin: '0', padding: '10px 14px', background: `linear-gradient(135deg, ${colors.cream}, white)`, borderBottom: `1px solid ${colors.creamDark}`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', width: '100%', flexShrink: 0 }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '12px', border: `2px dashed ${colors.teal}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.mapPin(colors.teal, 18)}</div>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <p style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>Add a Venue</p>
            <p style={{ fontSize: '11px', color: '#6b7280', margin: '1px 0 0' }}>Pick a spot on the map</p>
          </div>
          <div style={{ color: colors.teal, fontWeight: '700', fontSize: '20px' }}>+</div>
        </button>
      )}

      {/* Cash Pool Display */}
      {dmCashPool && (
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${colors.creamDark}`, backgroundColor: 'white', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>Cash Pool</h3>
            <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', fontWeight: '500', backgroundColor: dmCashPool.collected >= dmCashPool.total ? '#d1fae5' : '#fef3c7', color: dmCashPool.collected >= dmCashPool.total ? '#047857' : '#b45309' }}>
              ${dmCashPool.collected}/${dmCashPool.total}
            </span>
          </div>
          <div style={{ width: '100%', height: '8px', backgroundColor: '#e5e7eb', borderRadius: '4px', marginBottom: '8px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(dmCashPool.collected / dmCashPool.total) * 100}%`, background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, borderRadius: '4px', transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', boxShadow: dmCashPool.collected >= dmCashPool.total ? '0 0 12px rgba(13,40,71,0.4)' : 'none' }} />
          </div>
          {!dmCashPool.paid.includes('You') ? (
            <button onClick={(e) => { confirmClick(e); setDmCashPool(prev => ({ ...prev, paid: [...prev.paid, 'You'], collected: prev.collected + prev.perPerson })); sendDmMessage({ text: `💰 I paid $${dmCashPool.perPerson} to the pool!`, noReply: true }); }} style={{ width: '100%', padding: '8px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '700', fontSize: '13px', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Pay ${dmCashPool.perPerson}</button>
          ) : (
            <div style={{ textAlign: 'center', padding: '4px', color: colors.teal, fontWeight: '600', fontSize: '12px' }}>✓ Paid!</div>
          )}
        </div>
      )}

      {/* Vote panel — identical to flock with optimistic local updates */}
      {showDmVotePanel && (() => {
        const myName = authUser?.name;
        const totalVoters = new Set(dmVenueVotes.flatMap(v => v.voters || [])).size;
        const myVote = dmVenueVotes.find(v => (v.voters || []).includes(myName))?.venue_name || null;
        const pinnedName = dmPinnedVenue?.name || null;

        const handleDmQuickVote = (venueName, venueId) => {
          const existing = dmVenueVotes.find(v => v.venue_name === venueName);
          if (existing) {
            if ((existing.voters || []).includes(myName)) return; // already voted here
            // Switch vote: remove from old, add to new
            const newVotes = dmVenueVotes.map(v => ({
              ...v,
              voters: v.venue_name === venueName
                ? [...(v.voters || []), myName]
                : (v.voters || []).filter(x => x !== myName),
              vote_count: v.venue_name === venueName
                ? parseInt(v.vote_count || 0) + 1
                : (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
            })).filter(v => parseInt(v.vote_count || 0) > 0 || v.venue_name === venueName);
            setDmVenueVotes(newVotes);
          } else {
            // New vote: remove from old venues, add new entry
            const newVotes = [
              ...dmVenueVotes.map(v => ({
                ...v,
                voters: (v.voters || []).filter(x => x !== myName),
                vote_count: (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
              })).filter(v => parseInt(v.vote_count || 0) > 0),
              { venue_name: venueName, venue_id: venueId || null, vote_count: 1, voters: [myName] },
            ];
            setDmVenueVotes(newVotes);
          }
          dmVoteVenue(selectedDmId, venueName, venueId);
                 };

        const handleDmUnvote = () => {
          const newVotes = dmVenueVotes.map(v => ({
            ...v,
            voters: (v.voters || []).filter(x => x !== myName),
            vote_count: (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
          })).filter(v => parseInt(v.vote_count || 0) > 0);
          setDmVenueVotes(newVotes);
          if (myVote) dmVoteVenue(selectedDmId, myVote, dmVenueVotes.find(v => v.venue_name === myVote)?.venue_id);
        };

        const votesWithPinned = pinnedName && !dmVenueVotes.find(v => v.venue_name === pinnedName)
          ? [{ venue_name: pinnedName, venue_id: dmPinnedVenue?.place_id, vote_count: 0, voters: [], isPinned: true }, ...dmVenueVotes]
          : dmVenueVotes.map(v => ({ ...v, isPinned: v.venue_name === pinnedName }));
        const sortedVotes = [...votesWithPinned].sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (b.isPinned && !a.isPinned) return 1;
          return parseInt(b.vote_count || 0) - parseInt(a.vote_count || 0);
        });
        const suggestedVenues = popularVenues.filter(v => !votesWithPinned.find(fv => fv.venue_name === v.name)).slice(0, 8);

        return (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '80%', overflowY: 'auto' }}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.vote(colors.navy, 20)} Vote for a Venue</h2>
                  <p style={{ fontSize: '11px', color: '#9ca3af', margin: '2px 0 0' }}>{totalVoters} vote{totalVoters !== 1 ? 's' : ''} cast{myVote ? ` • You voted for ${myVote}` : ''}</p>
                </div>
                <button onClick={() => setShowDmVotePanel(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
              </div>

              {/* Current votes */}
              {sortedVotes.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                  {sortedVotes.map((v, idx) => {
                    const isMyVote = (v.voters || []).includes(myName);
                    const voteCount = parseInt(v.vote_count || 0);
                    const votePercent = totalVoters > 0 ? Math.round((voteCount / totalVoters) * 100) : 0;
                    const isLeading = !v.isPinned && idx === 0 && voteCount > 0;
                    const iconBg = v.isPinned
                      ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`
                      : isLeading ? `linear-gradient(135deg, ${colors.teal}, #0d9488)` : `linear-gradient(135deg, ${colors.navy}15, ${colors.navy}25)`;
                    return (
                      <button key={v.venue_name} onClick={(e) => { confirmClick(e); isMyVote ? handleDmUnvote() : handleDmQuickVote(v.venue_name, v.venue_id); }} style={{ width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: '14px', border: v.isPinned ? `2px solid ${colors.navy}` : isMyVote ? `2px solid ${colors.navy}` : '1.5px solid #e5e7eb', backgroundColor: v.isPinned ? `${colors.navy}05` : isMyVote ? `${colors.navy}06` : 'white', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'all 0.2s' }}>
                        {/* Progress bar background */}
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${votePercent}%`, backgroundColor: isMyVote ? `${colors.navy}10` : '#f8fafc', transition: 'width 0.4s ease', borderRadius: '14px' }} />
                        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {v.isPinned ? Icons.mapPin('white', 16) : isLeading ? Icons.flame('#fff', 18) : Icons.mapPin(colors.navy, 16)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <h4 style={{ fontSize: '14px', fontWeight: '700', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.venue_name}</h4>
                              {v.isPinned && <span style={{ fontSize: '9px', fontWeight: '700', color: 'white', backgroundColor: colors.navy, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Pinned</span>}
                              {isLeading && <span style={{ fontSize: '9px', fontWeight: '700', color: colors.teal, backgroundColor: `${colors.teal}15`, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Leading</span>}
                            </div>
                            <p style={{ fontSize: '11px', color: '#9ca3af', margin: '1px 0 0' }}>{(v.voters || []).length > 0 ? (v.voters || []).join(', ') : v.isPinned ? 'Current pinned venue — tap to vote' : 'No votes yet'}</p>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            {voteCount > 0 && <span style={{ fontSize: '16px', fontWeight: '900', color: isMyVote ? colors.navy : '#9ca3af' }}>{voteCount}</span>}
                            {isMyVote && <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.check('white', 12)}</div>}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: '20px', textAlign: 'center', backgroundColor: '#f8fafc', borderRadius: '14px', marginBottom: '16px' }}>
                  <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0, fontWeight: '500' }}>No votes yet. Be the first to suggest a venue!</p>
                </div>
              )}

              {/* Popular chains nearby */}
              {suggestedVenues.length > 0 && (
                <>
                  <p style={{ fontSize: '12px', fontWeight: '700', color: '#9ca3af', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Popular Chains Nearby</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {suggestedVenues.map(venue => (
                      <button key={venue.id || venue.name} onClick={(e) => { confirmClick(e); handleDmQuickVote(venue.name, venue.place_id); }} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: '12px', border: '1px solid #e5e7eb', backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.2s', position: 'relative', overflow: 'hidden' }}>
                        {venue.photo_url ? (
                          <img src={venue.photo_url} alt="" style={{ width: '36px', height: '36px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect fill="#1a3a5c" width="36" height="36" rx="8"/></svg>'); }} />
                        ) : (
                          <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {Icons.mapPin('white', 14)}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: '13px', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</p>
                          <p style={{ fontSize: '10px', color: '#9ca3af', margin: '1px 0 0' }}>{venue.type || venue.category}{venue.stars ? ` • ${venue.stars}★` : ''}{venue.price ? ` • ${venue.price}` : ''}</p>
                        </div>
                        <div style={{ padding: '6px 12px', borderRadius: '10px', backgroundColor: `${colors.navy}08`, color: colors.navy, fontSize: '11px', fontWeight: '700', flexShrink: 0 }}>
                          {Icons.vote(colors.navy, 12)} Vote
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Browse more button */}
              <button onClick={() => { setShowDmVotePanel(false); setShowDmVenueSearch(true); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: '#9ca3af', fontSize: '13px', fontWeight: '600', cursor: 'pointer', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                {Icons.plus('#9ca3af', 14)} Share a venue to chat
              </button>
            </div>
          </div>
        );
      })()}

      {/* Venue Share Modal — matches flock style exactly */}
      {showDmVenueSearch && (
        <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
          <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.mapPin(colors.navy, 20)} Share a Venue</h2>
              <button onClick={() => setShowDmVenueSearch(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
            </div>

            {/* Current pinned venue display */}
            {dmPinnedVenue ? (
              <div style={{ padding: '12px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.teal}15)`, border: `2px solid ${colors.teal}40`, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {Icons.mapPin('white', 18)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '10px', fontWeight: '600', color: colors.teal, margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pinned Venue</p>
                  <p style={{ fontSize: '14px', fontWeight: '700', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.name}</p>
                  {dmPinnedVenue.addr && <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.addr}</p>}
                </div>
                <button onClick={(e) => { confirmClick(e); sendDmMessage({ text: `Check out ${dmPinnedVenue.name}!`, message_type: 'venue_card', venue_data: { name: dmPinnedVenue.name, addr: dmPinnedVenue.addr, stars: dmPinnedVenue.rating, rating: dmPinnedVenue.rating, photo_url: dmPinnedVenue.photo_url, place_id: dmPinnedVenue.place_id }, noReply: true }); setShowDmVenueSearch(false); }} style={{ padding: '8px 12px', borderRadius: '10px', border: 'none', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, color: 'white', fontSize: '11px', fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap', position: 'relative', overflow: 'hidden' }}>Share This</button>
              </div>
            ) : (
              <div style={{ padding: '10px 12px', borderRadius: '12px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: '16px' }}>
                <p style={{ fontSize: '12px', color: '#6b7280', margin: 0, fontStyle: 'italic' }}>No venue pinned. Pick one below:</p>
              </div>
            )}

            <p style={{ fontSize: '12px', fontWeight: '600', color: '#6b7280', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Or select a different venue:</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {allVenues.map(venue => (
                <button
                  key={venue.id}
                  onClick={(e) => {
                    confirmClick(e);
                    sendDmMessage({ text: `Check out ${venue.name}!`, message_type: 'venue_card', venue_data: { name: venue.name, addr: venue.addr, stars: venue.stars, rating: venue.rating || venue.stars, price: venue.price, price_level: venue.price_level, photo_url: venue.photo_url, place_id: venue.place_id, category: venue.category, type: venue.type, crowd: venue.crowd, best: venue.best }, noReply: true });
                    setShowDmVenueSearch(false);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '14px', border: '1px solid #e2e8f0', backgroundColor: 'white', cursor: 'pointer', textAlign: 'left', transition: 'all 0.2s ease' }}
                >
                  <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {venue.category === 'Food' ? Icons.pizza('white', 20) : venue.category === 'Nightlife' ? Icons.cocktail('white', 20) : venue.category === 'Live Music' ? Icons.music('white', 20) : Icons.sports('white', 20)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: '14px', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                    <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0' }}>{venue.type} {venue.price ? `\u2022 ${venue.price}` : ''}</p>
                  </div>
                  <div style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: venue.crowd > 70 ? '#FEE2E2' : venue.crowd > 40 ? '#FEF3C7' : '#D1FAE5', color: venue.crowd > 70 ? colors.red : venue.crowd > 40 ? colors.amber : colors.teal, fontSize: '11px', fontWeight: '600' }}>
                    {venue.crowd}%
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Cash Pool Creation Modal */}
      {showDmCashPool && (
        <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
          <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Cash Pool</h2>
              <button onClick={() => setShowDmCashPool(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '16px' }}>
              <button onClick={() => setDmCashPoolAmount(prev => Math.max(5, prev - 5))} style={{ width: '44px', height: '44px', borderRadius: '22px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer', fontSize: '18px' }}>−</button>
              <span style={{ fontSize: '36px', fontWeight: '900', width: '100px', textAlign: 'center', color: colors.navy }}>${dmCashPoolAmount}</span>
              <button onClick={() => setDmCashPoolAmount(prev => prev + 5)} style={{ width: '44px', height: '44px', borderRadius: '22px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer', fontSize: '18px' }}>+</button>
            </div>
            <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', marginBottom: '20px' }}>Per person • Total: ${dmCashPoolAmount * 2}</p>
            <button onClick={(e) => {
              confirmClick(e);
              setDmCashPool({ perPerson: dmCashPoolAmount, total: dmCashPoolAmount * 2, collected: 0, paid: [] });
              sendDmMessage({ text: `💰 Cash Pool: $${dmCashPoolAmount}/person — let's split it!`, noReply: true });
              setShowDmCashPool(false);
                         }} style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '800', fontSize: '15px', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Create Pool</button>
          </div>
        </div>
      )}

      {/* Delete DM Confirmation Modal */}
      {showDeleteDmConfirm && (
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '16px' }}>
          <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '24px', width: '100%', maxWidth: '300px' }}>
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>{Icons.x('#EF4444', 24)}</div>
              <h3 style={{ fontSize: '16px', fontWeight: '900', color: colors.navy, margin: '0 0 8px' }}>Delete Conversation?</h3>
              <p style={{ fontSize: '13px', color: '#6b7280', margin: 0, lineHeight: '1.4' }}>Delete this conversation with {selectedDm.name}? Messages will be removed from your view.</p>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setShowDeleteDmConfirm(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => {
                const dmUserId = selectedDm.userId;
                setDirectMessages(prev => prev.filter(d => d.userId !== dmUserId));
                const updated = [...deletedDmUserIds, dmUserId];
                setDeletedDmUserIds(updated);
                try { localStorage.setItem('flock_deleted_dms', JSON.stringify(updated)); } catch {}
                setShowDeleteDmConfirm(false);
                setShowDmMenu(false);
                setCurrentScreen('main');
                             }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Image preview modal */}
      {showDmImagePreview && dmPendingImage && (
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '20px' }}>
          <img src={dmPendingImage} alt="Preview" style={{ maxWidth: '100%', maxHeight: '60%', borderRadius: '12px', objectFit: 'contain' }} />
          <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
            <button onClick={() => { setShowDmImagePreview(false); setDmPendingImage(null); }} style={{ padding: '12px 24px', borderRadius: '24px', border: '2px solid white', backgroundColor: 'transparent', color: 'white', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>Cancel</button>
            <button onClick={() => { sendDmMessage({ text: '📷 Photo', message_type: 'image', image_url: dmPendingImage, noReply: true }); setShowDmImagePreview(false); setDmPendingImage(null); }} style={{ padding: '12px 24px', borderRadius: '24px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>Send</button>
          </div>
        </div>
      )}

      {/* Messages area */}
      <div onScroll={() => document.activeElement?.blur()} style={{ flex: 1, padding: '16px', overflowY: 'auto', background: `linear-gradient(180deg, ${colors.cream} 0%, rgba(245,240,230,0.8) 100%)`, scrollBehavior: 'smooth' }}>
        {showDmChatSearch && dmChatSearch.trim() && selectedDm.messages.filter(m => {
          const q = dmChatSearch.toLowerCase();
          return m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q);
        }).length > 0 && (
          <div style={{ textAlign: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', color: '#6b7280', backgroundColor: 'rgba(255,255,255,0.8)', padding: '4px 12px', borderRadius: '12px' }}>
              {selectedDm.messages.filter(m => { const q = dmChatSearch.toLowerCase(); return m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q); }).length} matching messages
            </span>
          </div>
        )}
        {selectedDm.messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ width: '60px', height: '60px', borderRadius: '30px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', fontWeight: '700', color: 'white', overflow: 'hidden' }}>
              {selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '60px', height: '60px', borderRadius: '30px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?')}
            </div>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>Chat with {selectedDm.name}</h3>
            <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Say hi to start the conversation!</p>
          </div>
        ) : (
          (showDmChatSearch && dmChatSearch.trim()
            ? selectedDm.messages.filter(m => { const q = dmChatSearch.toLowerCase(); return m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q); })
            : selectedDm.messages
          ).map((m) => (
            <div key={m.id} style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexDirection: m.sender === 'You' ? 'row-reverse' : 'row' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: 'white', fontWeight: '700', flexShrink: 0, overflow: 'hidden' }}>
                {m.sender === 'You' ? 'Y' : (selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '32px', height: '32px', borderRadius: '16px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?'))}
              </div>
              <div style={{ maxWidth: '75%', position: 'relative' }}>
                {/* Reply reference */}
                {m.reply_to && (
                  <div style={{ padding: '4px 10px', marginBottom: '2px', borderLeft: `3px solid ${colors.navy}40`, borderRadius: '4px', backgroundColor: 'rgba(13,40,71,0.05)' }}>
                    <span style={{ fontSize: '10px', fontWeight: '600', color: colors.navy }}>{m.reply_to.sender}</span>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.reply_to.text}</p>
                  </div>
                )}
                {/* Venue card message — uses same VenueCard component as flocks */}
                {m.message_type === 'venue_card' && m.venue_data ? (
                  <VenueCard
                    venue={m.venue_data}
                    colors={colors}
                    Icons={Icons}
                    getCategoryColor={getCategoryColor}
                    onViewDetails={() => {
                      const vd = m.venue_data;
                      const pid = vd.place_id;
                      if (pid) {
                        openVenueDetail(pid, { name: vd.name, formatted_address: vd.addr, place_id: pid, rating: vd.stars || vd.rating, photo_url: vd.photo_url });
                      }
                    }}
                    onVote={() => {
                      const vName = m.venue_data.name;
                      const vId = m.venue_data.place_id;
                      const mn = authUser?.name;
                      const existing = dmVenueVotes.find(v => v.venue_name === vName);
                      if (existing && (existing.voters || []).includes(mn)) return;
                      if (existing) {
                        setDmVenueVotes(prev => prev.map(v => ({ ...v, voters: v.venue_name === vName ? [...(v.voters || []), mn] : (v.voters || []).filter(x => x !== mn), vote_count: v.venue_name === vName ? parseInt(v.vote_count || 0) + 1 : (v.voters || []).includes(mn) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0) })).filter(v => parseInt(v.vote_count || 0) > 0 || v.venue_name === vName));
                      } else {
                        setDmVenueVotes(prev => [...prev.map(v => ({ ...v, voters: (v.voters || []).filter(x => x !== mn), vote_count: (v.voters || []).includes(mn) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0) })).filter(v => parseInt(v.vote_count || 0) > 0), { venue_name: vName, venue_id: vId, vote_count: 1, voters: [mn] }]);
                      }
                      dmVoteVenue(selectedDmId, vName, vId);
                                         }}
                  />
                ) : m.message_type === 'image' && m.image_url ? (
                  /* Image message */
                  <div style={{ borderRadius: '16px', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.1)', borderTopRightRadius: m.sender === 'You' ? '4px' : '16px', borderTopLeftRadius: m.sender === 'You' ? '16px' : '4px' }}>
                    <img src={m.image_url} alt="" style={{ maxWidth: '100%', maxHeight: '240px', objectFit: 'cover', display: 'block', borderRadius: '16px' }} />
                  </div>
                ) : (
                  /* Text message */
                  <div onClick={() => setShowDmReactionPicker(showDmReactionPicker === m.id ? null : m.id)} style={{ borderRadius: '16px', padding: '10px 14px', fontSize: '13px', backgroundColor: m.sender === 'You' ? colors.navy : 'white', color: m.sender === 'You' ? 'white' : colors.navy, borderTopRightRadius: m.sender === 'You' ? '4px' : '16px', borderTopLeftRadius: m.sender === 'You' ? '16px' : '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', cursor: 'pointer' }}>
                    {showDmChatSearch && dmChatSearch.trim() && m.text?.toLowerCase().includes(dmChatSearch.toLowerCase()) ? (
                      m.text.split(new RegExp(`(${dmChatSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')).map((part, pi) =>
                        part.toLowerCase() === dmChatSearch.toLowerCase() ? <mark key={pi} style={{ background: '#fde047', color: 'inherit', borderRadius: '2px', padding: '0 1px' }}>{part}</mark> : part
                      )
                    ) : m.text}
                  </div>
                )}
                {/* Reactions display */}
                {m.reactions && m.reactions.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap', justifyContent: m.sender === 'You' ? 'flex-end' : 'flex-start' }}>
                    {Object.entries(m.reactions.reduce((acc, r) => { acc[r.emoji] = (acc[r.emoji] || 0) + 1; return acc; }, {})).map(([emoji, count]) => (
                      <span key={emoji} onClick={() => { const otherUser = selectedDmId; if (m.reactions.some(r => r.emoji === emoji && r.user_id === authUser?.id)) { dmRemoveReact(m.id, emoji, otherUser); } else { dmReact(m.id, emoji, otherUser); } }} style={{ fontSize: '12px', backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '2px 6px', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>{emoji} {count > 1 ? count : ''}</span>
                    ))}
                  </div>
                )}
                {/* Reaction picker */}
                {showDmReactionPicker === m.id && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '4px', backgroundColor: 'white', borderRadius: '16px', padding: '4px 8px', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', position: 'absolute', [m.sender === 'You' ? 'right' : 'left']: 0, bottom: '-8px', zIndex: 5 }}>
                    {dmReactions.map(emoji => (
                      <button key={emoji} onClick={(e) => { e.stopPropagation(); dmReact(m.id, emoji, selectedDmId); setShowDmReactionPicker(null); }} style={{ fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', borderRadius: '8px', transition: 'transform 0.15s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.3)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                      >{emoji}</button>
                    ))}
                    <button onClick={(e) => { e.stopPropagation(); setDmReplyingTo(m); setShowDmReactionPicker(null); }} style={{ fontSize: '14px', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: colors.navy, fontWeight: '700' }} title="Reply">↩</button>
                  </div>
                )}
                <p style={{ fontSize: '9px', color: '#9ca3af', margin: '4px 4px 0', textAlign: m.sender === 'You' ? 'right' : 'left' }}>{getRelativeTime(m.time)}</p>
              </div>
            </div>
          ))
        )}
        {/* Typing indicator */}
        <div style={{ height: '50px', overflow: 'hidden', opacity: dmIsTyping ? 1 : 0, transition: 'opacity 0.2s ease', pointerEvents: dmIsTyping ? 'auto' : 'none' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'white', border: '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', color: colors.navy }}>{selectedDm.name?.[0] || '?'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '11px', color: colors.navy, fontWeight: '600', marginBottom: '4px', paddingLeft: '4px' }}>{dmTypingUser || selectedDm.name}</span>
              <div style={{ padding: '10px 16px', backgroundColor: 'white', borderRadius: '18px', borderBottomLeftRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out infinite', opacity: 0.7 }} />
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out 0.2s infinite', opacity: 0.7 }} />
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out 0.4s infinite', opacity: 0.7 }} />
              </div>
            </div>
          </div>
        </div>
        <div ref={dmChatEndRef} />
      </div>

      {/* Reply bar */}
      {dmReplyingTo && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid #eee', backgroundColor: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <div style={{ flex: 1, borderLeft: `3px solid ${colors.navy}`, paddingLeft: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>Replying to {dmReplyingTo.sender}</span>
            <p style={{ fontSize: '11px', color: '#6b7280', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmReplyingTo.text}</p>
          </div>
          <button onClick={() => setDmReplyingTo(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#6b7280', 14)}</button>
        </div>
      )}

      {/* Input bar — text + camera + venue search + send */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid #eee', backgroundColor: 'white' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Camera button */}
          <button onClick={() => setShowDmCameraPopup(true)} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, border: 'none', position: 'relative' }}>
            {Icons.camera('#6b7280', 16)}
          </button>
          <input ref={dmGalleryInputRef} type="file" accept="image/*" onChange={handleDmImageSelect} style={{ display: 'none' }} />
          {/* Location share button */}
          <button onClick={() => { if (dmSharingLocation) { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); setDmMemberLocation(null); } else { setDmSharingLocation(selectedDmId); } }} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: dmSharingLocation ? '#10b981' : '#f3f4f6', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>{Icons.mapPin(dmSharingLocation ? 'white' : '#6b7280', 16)}</button>
          <input type="text" value={chatInput} onChange={handleDmInputChange} onKeyDown={(e) => e.key === 'Enter' && sendDmMessage()} placeholder={dmReplyingTo ? `Reply...` : `Message ${selectedDm.name}...`} style={{ flex: 1, padding: '12px 16px', borderRadius: '24px', backgroundColor: '#f3f4f6', border: '1px solid rgba(0,0,0,0.05)', fontSize: '13px', outline: 'none' }} autoComplete="off" />
          <button onClick={() => sendDmMessage()} disabled={!chatInput.trim()} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: chatInput.trim() ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : '#e5e7eb', color: 'white', cursor: chatInput.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.send('white', 18)}</button>
        </div>
      </div>

      {/* Camera options popup */}
      {showDmCameraPopup && (
        <div onClick={() => setShowDmCameraPopup(false)} style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', zIndex: 60 }}>
          <div onClick={e => e.stopPropagation()} style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', paddingBottom: '28px' }}>
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: '#d1d5db', margin: '0 auto 16px' }} />
            <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Add Photo</h3>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button onClick={() => openCameraViewfinder('dm')} style={{ flex: 1, padding: '16px', borderRadius: '16px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', transition: 'all 0.2s ease' }}>
                {Icons.camera(colors.navy, 28)}
                <span style={{ fontSize: '13px', fontWeight: '700', color: colors.navy }}>Take Photo</span>
              </button>
              <button onClick={() => { setShowDmCameraPopup(false); setTimeout(() => dmGalleryInputRef.current?.click(), 100); }} style={{ flex: 1, padding: '16px', borderRadius: '16px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', transition: 'all 0.2s ease' }}>
                {Icons.image(colors.navy, 28)}
                <span style={{ fontSize: '13px', fontWeight: '700', color: colors.navy }}>Gallery</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // AI Assistant Modal - Data
  const aiSuggestedQuestions = [
    { text: "Where's poppin rn?", icon: Icons.activity },
    { text: "When should we hit Blue Heron?", icon: Icons.clock },
    { text: "Pick a bar for us", icon: Icons.cocktail },
    { text: "I'm hungry tho", icon: Icons.pizza },
  ];

  const aiQuickActions = [
    { label: 'Scout Spots', icon: Icons.compass, action: () => { setShowAiAssistant(false); setCurrentTab('explore'); } },
    { label: 'Rally the Flock', icon: Icons.users, action: () => { setShowAiAssistant(false); setCurrentScreen('create'); } },
    { label: 'Check Plans', icon: Icons.calendar, action: () => { setShowAiAssistant(false); setCurrentTab('calendar'); } },
  ];

  // AI Assistant Modal - Inline JSX (not a component to prevent focus loss)
  const aiAssistantModal = showAiAssistant && (
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
        <div style={{ backgroundColor: 'white', borderRadius: '24px 24px 0 0', width: '100%', height: '80%', display: 'flex', flexDirection: 'column' }}>
          {/* Header with animated AI avatar */}
          <div style={{ padding: '12px', borderBottom: '1px solid #eee', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, borderRadius: '24px 24px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ position: 'relative' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '20px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(79,70,229,0.4)' }}>
                  {Icons.robot('white', 22)}
                </div>
                <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: '#22C55E', border: '2px solid white', animation: 'pulse 2s ease-in-out infinite' }} />
              </div>
              <div>
                <h2 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', margin: 0 }}>Birdie</h2>
                <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {Icons.sparkles('rgba(255,255,255,0.7)', 10)}
                  <span>your personal wingman</span>
                </p>
              </div>
            </div>
            <button onClick={() => setShowAiAssistant(false)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 16)}</button>
          </div>

          {/* Quick Actions */}
          <div style={{ padding: '10px 12px', backgroundColor: '#f9fafb', borderBottom: '1px solid #eee', display: 'flex', gap: '8px' }}>
            {aiQuickActions.map((action, i) => (
              <button key={i} onClick={action.action} style={{ flex: 1, padding: '8px', borderRadius: '10px', border: '1px solid rgba(13,40,71,0.1)', backgroundColor: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                {action.icon(colors.navy, 16)}
                <span style={{ fontSize: '9px', fontWeight: '600', color: colors.navy }}>{action.label}</span>
              </button>
            ))}
          </div>

          {/* Messages */}
          <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
            {aiMessages.length === 1 && (
              <div style={{ textAlign: 'center', padding: '16px 0', marginBottom: '12px' }}>
                <div style={{ width: '60px', height: '60px', borderRadius: '30px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(79,70,229,0.3)' }}>
                  {Icons.robot('white', 30)}
                </div>
                <h3 style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>How can I help?</h3>
                <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Ask about venues, crowds, or plans.</p>
              </div>
            )}

            {aiMessages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: msg.role === 'user' ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
                  {msg.role === 'user' ? Icons.user('white', 14) : Icons.robot('white', 14)}
                </div>
                <div style={{ maxWidth: '78%' }}>
                  <div style={{ borderRadius: '16px', padding: '10px 12px', fontSize: '13px', backgroundColor: msg.role === 'user' ? colors.navy : '#f3f4f6', color: msg.role === 'user' ? 'white' : colors.navy, borderTopRightRadius: msg.role === 'user' ? '4px' : '16px', borderTopLeftRadius: msg.role === 'user' ? '16px' : '4px', boxShadow: msg.role === 'user' ? '0 2px 8px rgba(13,40,71,0.2)' : '0 1px 3px rgba(0,0,0,0.05)' }}>
                    {msg.text}
                  </div>
                  {msg.role === 'assistant' && msg.confidence && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px', paddingLeft: '4px' }}>
                      {Icons.activity('#9ca3af', 10)}
                      <span style={{ fontSize: '9px', color: '#9ca3af' }}>{msg.confidence}% confidence</span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {aiTyping && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse 1.5s ease-in-out infinite' }}>
                  {Icons.robot('white', 14)}
                </div>
                <div style={{ backgroundColor: '#f3f4f6', borderRadius: '16px', borderTopLeftRadius: '4px', padding: '12px 16px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#4F46E5', animation: 'bounce 1.4s ease-in-out infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#7C3AED', animation: 'bounce 1.4s ease-in-out 0.15s infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#4F46E5', animation: 'bounce 1.4s ease-in-out 0.3s infinite' }} />
                </div>
              </div>
            )}
          </div>

          {/* Suggested Questions */}
          {aiMessages.length <= 2 && !aiTyping && (
            <div style={{ padding: '8px 12px', borderTop: '1px solid #eee', backgroundColor: '#f9fafb' }}>
              <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Try asking</p>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {aiSuggestedQuestions.map((q, i) => (
                  <button key={i} onClick={() => { setAiInput(q.text); }} style={{ padding: '6px 10px', borderRadius: '16px', border: '1px solid rgba(13,40,71,0.15)', backgroundColor: 'white', cursor: 'pointer', fontSize: '11px', color: colors.navy, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {q.icon(colors.navy, 12)}
                    {q.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid #eee', backgroundColor: 'white' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input ref={aiInputRef} type="text" value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendAiMessage()} placeholder="Ask me anything..." style={{ flex: 1, padding: '12px 16px', borderRadius: '24px', backgroundColor: '#f3f4f6', border: '1px solid rgba(0,0,0,0.05)', fontSize: '13px', outline: 'none', fontWeight: '500' }} autoComplete="off" />
              <button onClick={sendAiMessage} disabled={!aiInput.trim()} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: aiInput.trim() ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : '#e5e7eb', color: 'white', cursor: aiInput.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: aiInput.trim() ? '0 4px 12px rgba(13,40,71,0.3)' : 'none', transition: 'all 0.2s' }}>{Icons.send('white', 18)}</button>
            </div>
          </div>
        </div>
      </div>
  );

  // Mode Selection Handler
  const selectMode = (mode) => {
    if (mode === 'admin') {
      setShowAdminPrompt(true);
    } else {
      localStorage.setItem('flockUserMode', mode);
      setUserMode(mode);
      setShowModeSelection(false);
      if (mode === 'venue') {
        setCurrentScreen('venueDashboard');
      }
    }
  };

  const switchMode = () => {
    localStorage.removeItem('flockUserMode');
    setUserMode(null);
    setShowModeSelection(true);
    setCurrentScreen('main');
    setCurrentTab('home');
  };

  // Easter egg - tap counter (state used via callback in setEasterEggTaps)
  // eslint-disable-next-line no-unused-vars
  const [easterEggTaps, setEasterEggTaps] = useState(0);

  // WELCOME SCREEN - Mode Selection
  const WelcomeScreen = () => (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream, padding: '20px', boxSizing: 'border-box' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        {/* Logo */}
        <div
          onClick={() => {
            setEasterEggTaps(prev => {
              const newCount = prev + 1;
              if (newCount === 7) {
                // Easter egg found
                return 0;
              }
              // Easter egg hint at 5 taps
              return newCount;
            });
          }}
          style={{ width: '80px', height: '80px', borderRadius: '24px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px', boxShadow: '0 8px 32px rgba(13,40,71,0.3)', cursor: 'pointer' }}
        >
          {Icons.users('white', 40)}
        </div>
        <h1 style={{ fontSize: '28px', fontWeight: '900', color: colors.navy, margin: '0 0 4px', textAlign: 'center' }}>Flock</h1>
        <p style={{ fontSize: '13px', color: colors.navyMid, margin: '0 0 28px', textAlign: 'center', fontWeight: '500' }}>Social Coordination Simplified</p>

        {/* Mode Cards */}
        <div style={{ width: '100%', maxWidth: '320px' }}>
          {/* User Mode */}
          <button onClick={() => selectMode('user')} style={{ width: '100%', padding: '20px', borderRadius: '16px', border: 'none', background: 'white', marginBottom: '12px', cursor: 'pointer', textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: '16px', transition: 'transform 0.2s, box-shadow 0.2s' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.users('white', 28)}
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 4px' }}>I'm Going Out</h3>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Coordinate with friends, find venues</p>
            </div>
            <span style={{ fontSize: '20px', color: colors.navy }}>›</span>
          </button>

          {/* Venue Owner Mode */}
          <button onClick={() => selectMode('venue')} style={{ width: '100%', padding: '20px', borderRadius: '16px', border: 'none', background: 'white', marginBottom: '12px', cursor: 'pointer', textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: '16px', transition: 'transform 0.2s, box-shadow 0.2s' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'linear-gradient(135deg, #7C3AED, #5B21B6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.building('white', 28)}
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 4px' }}>Venue Dashboard</h3>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Manage your venue, see traffic</p>
            </div>
            <span style={{ fontSize: '20px', color: colors.navy }}>›</span>
          </button>

          {/* Admin Mode */}
          <button onClick={() => selectMode('admin')} style={{ width: '100%', padding: '20px', borderRadius: '16px', border: 'none', background: 'white', marginBottom: '12px', cursor: 'pointer', textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: '16px', transition: 'transform 0.2s, box-shadow 0.2s' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'linear-gradient(135deg, #059669, #047857)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.briefcase('white', 28)}
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 4px' }}>Admin Dashboard</h3>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Platform analytics & revenue</p>
            </div>
            <span style={{ fontSize: '9px', color: '#9ca3af', backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '4px' }}>Locked</span>
          </button>
        </div>
      </div>

      {/* Footer */}
      <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', margin: 0 }}>You can switch modes anytime in your profile</p>
    </div>
  );

  // HOME SCREEN
  const HomeScreen = () => {
    const headerScale = Math.max(1 - scrollY * 0.002, 0.95);

    return (
    <div key="home-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
      {/* Header with Parallax */}
      <div style={{
        padding: '16px',
        paddingBottom: '20px',
        background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
        flexShrink: 0,
        transform: `scale(${headerScale})`,
        transformOrigin: 'top center',
        transition: 'transform 0.1s ease-out'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0, letterSpacing: '0.5px' }}>Good evening</p>
            <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0 }}>Hey, {profileName}</h1>
          </div>
          <button onClick={() => setCurrentTab('profile')} style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user('white', 22)}
            </div>
            <span style={{ position: 'absolute', bottom: '-2px', right: '-2px', padding: '2px 6px', borderRadius: '10px', fontSize: '9px', fontWeight: 'bold', color: 'white', backgroundColor: colors.amber }}>L{userLevel}</span>
          </button>
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ flex: 1.1, borderRadius: '14px', padding: '12px 10px', backgroundColor: 'rgba(255,255,255,0.12)' }}>
            <p style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)', margin: 0, textTransform: 'uppercase', letterSpacing: '1px' }}>Active</p>
            <p style={{ fontSize: '22px', fontWeight: '900', color: 'white', margin: '4px 0 0' }}>{flocks.length}</p>
          </div>
          <div style={{ flex: 0.9, borderRadius: '10px', padding: '10px 8px', backgroundColor: 'rgba(255,255,255,0.08)' }}>
            <p style={{ fontSize: '9px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>Streak</p>
            <p style={{ fontSize: '16px', fontWeight: '800', color: 'white', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.flame('#F59E0B', 16)} {streak}</p>
          </div>
          <div style={{ flex: 1, borderRadius: '12px', padding: '10px', backgroundColor: 'rgba(255,255,255,0.1)' }}>
            <p style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)', margin: 0, textTransform: 'uppercase' }}>XP</p>
            <p style={{ fontSize: '17px', fontWeight: '700', color: 'white', margin: '2px 0 0' }}>{userXP}</p>
            <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '2px', marginTop: '4px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${userXP % 100}%`, backgroundColor: colors.amber, borderRadius: '2px', transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', boxShadow: '0 0 8px rgba(245,158,11,0.5)' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div onScroll={handleScroll} style={{ flex: 1, padding: '12px', overflowY: 'auto', marginTop: '-8px' }}>
        {/* Stories */}
        {stories.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
          {stories.map(s => (
            <button key={s.id} onClick={() => { setViewingStory(s); setStoryIndex(0); }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
              <div style={{ width: '52px', height: '52px', borderRadius: '26px', padding: '2px', background: s.hasNew ? `linear-gradient(135deg, ${colors.navy}, ${colors.skyBlue})` : '#d1d5db' }}>
                <div style={{ width: '100%', height: '100%', borderRadius: '24px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>{s.avatar}</div>
              </div>
              <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{s.name}</span>
            </button>
          ))}
        </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
          <button
            onClick={() => setCurrentScreen('create')}
            style={{
              flex: 1.2,
              padding: '16px',
              borderRadius: '16px',
              border: 'none',
              background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
              color: 'white',
              fontWeight: '800',
              fontSize: '14px',
              cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(13,40,71,0.3), 0 2px 4px rgba(0,0,0,0.1)',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            {Icons.plus('white', 16)} Start a Flock
          </button>
          <button
            onClick={() => setCurrentScreen('addFriends')}
            style={{
              flex: 0.8,
              padding: '14px',
              borderRadius: '14px',
              border: `2px solid ${colors.navy}`,
              backgroundColor: 'white',
              color: colors.navy,
              fontWeight: '700',
              fontSize: '13px',
              cursor: 'pointer',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              boxShadow: '0 2px 8px rgba(13,40,71,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            {Icons.userPlus(colors.navy, 15)} Add Friends
          </button>
        </div>

        {/* Activity */}
        <div style={styles.card}>
          <h3 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.bell(colors.navy, 14)} Activity</h3>
          {activityFeed.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
              <span>{a.icon}</span>
              <p style={{ fontSize: '11px', flex: 1, margin: 0 }}><span style={{ fontWeight: 'bold' }}>{a.user}</span> {a.action} <span style={{ color: colors.navyMid }}>{a.target}</span></p>
              <span style={{ fontSize: '10px', color: '#9ca3af' }}>{a.time}</span>
            </div>
          ))}
        </div>

        {/* Flocks */}
        <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px' }}>Your Flocks</h2>
        {flocks.map((f, idx) => (
          <button key={f.id} className={`card-animate card-animate-${Math.min(idx + 1, 5)}`} onClick={() => { setSelectedFlockId(f.id); setCurrentScreen('detail'); }} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', padding: idx === 0 ? '18px' : '12px', marginBottom: idx === 0 ? '14px' : '10px', borderLeft: idx === 0 ? `4px solid ${colors.teal}` : 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: idx === 0 ? '10px' : '6px' }}>
              <div>
                <h3 style={{ fontSize: idx === 0 ? '16px' : '14px', fontWeight: idx === 0 ? '800' : 'bold', color: colors.navy, margin: 0 }}>{f.name}</h3>
                <p style={{ fontSize: idx === 0 ? '11px' : '10px', color: '#6b7280', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin('#6b7280', idx === 0 ? 12 : 10)} {f.venue}</p>
              </div>
              <span style={{ fontSize: '10px', padding: idx === 0 ? '4px 10px' : '2px 8px', borderRadius: '10px', fontWeight: '600', backgroundColor: f.status === 'voting' ? '#fef3c7' : '#d1fae5', color: f.status === 'voting' ? '#b45309' : '#047857' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>{f.status === 'voting' ? Icons.vote('#b45309', 10) : Icons.check('#047857', 10)} {f.status === 'voting' ? 'Needs Votes' : 'Locked In'}</span>
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex' }}>
                {f.members.slice(0, idx === 0 ? 5 : 4).map((m, j) => (
                  <div key={j} style={{ width: idx === 0 ? '28px' : '24px', height: idx === 0 ? '28px' : '24px', borderRadius: '50%', border: '2px solid white', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: idx === 0 ? '10px' : '9px', fontWeight: 'bold', color: 'white', marginLeft: j > 0 ? '-6px' : 0 }}>{m[0]}</div>
                ))}
                {idx === 0 && f.members.length > 5 && <div style={{ width: '28px', height: '28px', borderRadius: '50%', border: '2px solid white', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 'bold', color: colors.navy, marginLeft: '-6px' }}>+{f.members.length - 5}</div>}
              </div>
              <span style={{ fontSize: idx === 0 ? '11px' : '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '10px', backgroundColor: colors.cream, color: colors.navy }}>{f.time}</span>
            </div>
          </button>
        ))}

        {/* Safety Check-in */}
        <button onClick={() => setShowCheckin(true)} style={{ width: '100%', marginTop: '8px', padding: '14px', borderRadius: '14px', border: `2px dashed ${colors.teal}`, backgroundColor: 'rgba(20,184,166,0.05)', color: colors.teal, fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
          {Icons.shield(colors.teal, 16)} Safety Check-in
        </button>
      </div>

      <AIButton />
      <SafetyButton />
      <BottomNav />
    </div>
  );
  };

  // CREATE SCREEN
  const CreateScreen = () => {
    const priceLabel = (level) => {
      if (!level) return '';
      return '$'.repeat(level);
    };

    const StarRating = ({ rating }) => {
      if (!rating) return null;
      const full = Math.floor(rating);
      const half = rating - full >= 0.3;
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '1px' }}>
          {[...Array(5)].map((_, i) => (
            <svg key={i} width={12} height={12} viewBox="0 0 24 24" fill={i < full ? '#F59E0B' : (i === full && half ? 'url(#halfStar)' : '#d1d5db')} stroke="none">
              {i === full && half && (
                <defs><linearGradient id="halfStar"><stop offset="50%" stopColor="#F59E0B"/><stop offset="50%" stopColor="#d1d5db"/></linearGradient></defs>
              )}
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          ))}
        </span>
      );
    };

    const handleCreate = async () => {
      if (!flockName.trim()) { showToast('Enter a plan name', 'error'); return; }
      // If only 1 person invited, redirect to DM instead
      const invitedFriends = flockFriends.filter(f => f.id);
      if (invitedFriends.length === 1) {
        const friend = invitedFriends[0];
        startNewDmWithUser({ id: friend.id, name: friend.name, profile_image_url: friend.profile_image_url || null });
        setFlockName(''); setFlockFriends([]); setInviteSearch(''); setInviteResults([]); setFlockCashPool(false); setSelectedVenueForCreate(null);
               return;
      }
      setIsLoading(true);

      // Capture form values before clearing
      const capturedName = flockName;
      const capturedVenue = selectedVenueForCreate;
      const capturedFriends = [...flockFriends];
      const venueName = capturedVenue?.name || null;
      const venueAddr = capturedVenue?.addr || capturedVenue?.formatted_address || null;
      const venueId = capturedVenue?.place_id || null;
      const venuePhoto = capturedVenue?.photo_url || null;
      const venueRating = capturedVenue?.rating || capturedVenue?.stars || null;
      const venuePriceLevel = capturedVenue?.price_level || null;
      const venueLat = capturedVenue?.lat || capturedVenue?.location?.latitude || null;
      const venueLng = capturedVenue?.lng || capturedVenue?.location?.longitude || null;
      const invitedIds = capturedFriends.map(f => f.id).filter(Boolean);

      // Clear form immediately for snappy feel
      setFlockName(''); setFlockFriends([]); setInviteSearch(''); setInviteResults([]); setFlockCashPool(false); setSelectedVenueForCreate(null);

      try {
        const data = await apiCreateFlock({ name: capturedName, venue_name: venueName, venue_address: venueAddr, venue_id: venueId, venue_latitude: venueLat || undefined, venue_longitude: venueLng || undefined, venue_rating: venueRating || undefined, venue_photo_url: venuePhoto || undefined, invited_user_ids: invitedIds.length > 0 ? invitedIds : undefined });
        const f = data.flock;
        const initialMessages = [];
        if (venueName) {
          const venueCardData = { name: venueName, addr: venueAddr, place_id: venueId, photo_url: venuePhoto, rating: venueRating, stars: venueRating, price: venuePriceLevel ? '$'.repeat(venuePriceLevel) : null, price_level: venuePriceLevel, type: capturedVenue?.type || 'Venue', category: capturedVenue?.category || 'Food', crowd: capturedVenue?.crowd || Math.round(20 + Math.random() * 60), lat: venueLat, lng: venueLng };
          initialMessages.push({
            id: Date.now(),
            sender: 'You',
            time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            text: `Check out ${venueName}!`,
            reactions: [],
            message_type: 'venue_card',
            venue_data: venueCardData,
          });
          // Persist venue card to backend (fire-and-forget)
          apiSendMessage(f.id, `Check out ${venueName}!`, { message_type: 'venue_card', venue_data: venueCardData }).catch(() => {});
        }
        const invitedNames = capturedFriends.map(fr => fr.name);
        const newFlock = { id: f.id, name: f.name, host: authUser?.name || 'You', creatorId: f.creator_id, members: invitedNames, memberCount: 1 + invitedIds.length, time: f.event_time ? new Date(f.event_time).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : `${flockDate} ${flockTime}`, status: 'voting', venue: f.venue_name || 'TBD', venueAddress: venueAddr, venueId: venueId, venuePhoto: venuePhoto, venueRating: venueRating, venuePriceLevel: venuePriceLevel, venueLat: venueLat, venueLng: venueLng, cashPool: null, votes: [], messages: initialMessages };

        // Batch all state updates together — navigate immediately
        newlyCreatedFlockRef.current = f.id;
        setFlocks(prev => [...prev, newFlock]);
        setSelectedFlockId(f.id);
        setCurrentScreen('chatDetail');
        setIsLoading(false);
        // Defer XP animation so it doesn't compete with screen transition
        setTimeout(() => addXP(50), 600);
      } catch (err) {
        showToast(err.message || 'Failed to create flock', 'error');
        setIsLoading(false);
      }
    };

    return (
      <div key="create-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
        <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: colors.cream, flexShrink: 0 }}>
          <button onClick={() => { setCurrentScreen('main'); setFlockName(''); setFlockFriends([]); setInviteSearch(''); setInviteResults([]); setSelectedVenueForCreate(null); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
          <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Start a Flock</h1>
        </div>

        <div style={{ flex: 1, padding: '16px', overflowY: 'auto', backgroundColor: colors.cream }}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>What's the plan?</label>
            <input key="flock-name-input" id="flock-name-input" type="text" value={flockName} onChange={(e) => setFlockName(e.target.value)} placeholder="Movie night, dinner, party..." style={styles.input} autoComplete="off" />
          </div>

          {/* VENUE PICKER — Browse on Discover tab */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>{Icons.mapPin(colors.navy, 12)} Venue</label>

            {selectedVenueForCreate ? (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '10px', border: `2px solid ${colors.teal}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
                {selectedVenueForCreate.photo_url ? (
                  <img src={selectedVenueForCreate.photo_url} alt="" style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover' }} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect fill="#1a3a5c" width="48" height="48" rx="8"/></svg>'); }} />
                ) : (
                  <div style={{ width: '48px', height: '48px', borderRadius: '8px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.mapPin(colors.navy, 20)}</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedVenueForCreate.name}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                    {selectedVenueForCreate.rating && <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>{selectedVenueForCreate.rating}</span>}
                    {selectedVenueForCreate.rating && <StarRating rating={selectedVenueForCreate.rating} />}
                    {selectedVenueForCreate.price_level && <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600' }}>{priceLabel(selectedVenueForCreate.price_level)}</span>}
                  </div>
                  <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedVenueForCreate.addr}</p>
                </div>
                <button onClick={() => { setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ padding: '4px 10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, backgroundColor: colors.cream, color: colors.navy, fontWeight: '600', fontSize: '11px', cursor: 'pointer', flexShrink: 0 }}>Change</button>
              </div>
            ) : (
              <button onClick={() => { setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.mapPin(colors.teal, 18)} Browse Venues
              </button>
            )}
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>When</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              {['Tonight', 'Tomorrow', 'This Weekend', 'Next Week'].map(d => (
                <button key={d} onClick={() => setFlockDate(d)} style={{ padding: '10px', borderRadius: '8px', border: `2px solid ${flockDate === d ? colors.navy : colors.creamDark}`, backgroundColor: flockDate === d ? colors.navy : 'white', color: flockDate === d ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>{d}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Time</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {['7 PM', '8 PM', '9 PM', '10 PM', '11 PM'].map(t => (
                <button key={t} onClick={() => setFlockTime(t)} style={{ padding: '6px 12px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: flockTime === t ? colors.navy : 'white', color: flockTime === t ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>{t}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>{Icons.users(colors.navy, 12)} Invite {flockFriends.length > 0 && `(${flockFriends.length})`}</label>

            {/* Selected friends chips */}
            {flockFriends.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                {flockFriends.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px 4px 4px', borderRadius: '20px', backgroundColor: colors.navy, color: 'white' }}>
                    <div style={{ width: '22px', height: '22px', borderRadius: '11px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700' }}>
                      {f.profile_image_url ? <img src={f.profile_image_url} alt="" style={{ width: '22px', height: '22px', borderRadius: '11px', objectFit: 'cover' }} /> : f.name[0]?.toUpperCase()}
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: '600' }}>{f.name.split(' ')[0]}</span>
                    <button onClick={() => setFlockFriends(prev => prev.filter(x => x.id !== f.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center' }}>{Icons.x('rgba(255,255,255,0.7)', 12)}</button>
                  </div>
                ))}
              </div>
            )}

            {/* Suggested friends - quick add */}
            {suggestedUsers.filter(u => !flockFriends.some(f => f.id === u.id)).length > 0 && (
              <div style={{ marginBottom: '8px' }}>
                <p style={{ fontSize: '10px', fontWeight: '600', color: '#9ca3af', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Suggested</p>
                <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
                  {suggestedUsers.filter(u => !flockFriends.some(f => f.id === u.id)).slice(0, 5).map(user => (
                    <button key={user.id} onClick={() => setFlockFriends(prev => [...prev, user])} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderRadius: '20px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s ease' }}>
                      <div style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700', color: 'white', overflow: 'hidden', flexShrink: 0 }}>
                        {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '24px', height: '24px', borderRadius: '12px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                      </div>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, whiteSpace: 'nowrap' }}>{user.name.split(' ')[0]}</span>
                      <span style={{ fontSize: '12px', color: colors.teal, fontWeight: '700' }}>+</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Search input */}
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={inviteSearch}
                onChange={(e) => handleInviteSearch(e.target.value)}
                placeholder="Or search by name or email..."
                style={{ ...styles.input, paddingLeft: '36px', paddingRight: inviteSearch ? '36px' : '12px', fontSize: '12px' }}
                autoComplete="off"
              />
              <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search('#94a3b8', 14)}</span>
              {inviteSearch && (
                <button onClick={() => { setInviteSearch(''); setInviteResults([]); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#94a3b8', 14)}</button>
              )}
            </div>

            {/* Search results */}
            {inviteSearching && (
              <div style={{ textAlign: 'center', padding: '10px 0' }}>
                <div style={{ display: 'inline-block', width: '14px', height: '14px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: '11px', color: '#6b7280', marginLeft: '6px' }}>Searching...</span>
              </div>
            )}
            {!inviteSearching && inviteSearch.trim().length >= 1 && inviteResults.length > 0 && (
              <div style={{ maxHeight: '160px', overflowY: 'auto', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'white', marginTop: '6px' }}>
                {inviteResults.filter(u => !flockFriends.some(f => f.id === u.id)).map((user, i, arr) => (
                  <button key={user.id} onClick={() => {
                    setFlockFriends(prev => [...prev, user]);
                    setInviteSearch('');
                    setInviteResults([]);
                  }} style={{ width: '100%', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', borderBottom: i < arr.length - 1 ? `1px solid ${colors.creamDark}` : 'none', backgroundColor: 'white', cursor: 'pointer', textAlign: 'left' }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                      {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '32px', height: '32px', borderRadius: '16px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: '700', fontSize: '13px', color: colors.navy, margin: 0 }}>{user.name}</p>
                      <p style={{ fontSize: '10px', color: '#9ca3af', margin: '1px 0 0' }}>{user.email}</p>
                    </div>
                    <div style={{ padding: '4px 10px', borderRadius: '8px', backgroundColor: colors.cream, color: colors.teal, fontSize: '11px', fontWeight: '700', flexShrink: 0 }}>Add</div>
                  </button>
                ))}
              </div>
            )}
            {!inviteSearching && inviteSearch.trim().length >= 1 && inviteResults.length === 0 && (
              <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '8px 0', margin: 0 }}>No users found</p>
            )}
          </div>

          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.dollar(colors.navy, 14)} Cash Pool</label>
              <Toggle on={flockCashPool} onChange={() => setFlockCashPool(!flockCashPool)} />
            </div>
            {flockCashPool && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', border: `1px solid ${colors.creamDark}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '12px', fontWeight: '500' }}>Per person</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button onClick={() => setFlockAmount(prev => Math.max(5, prev - 5))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>−</button>
                    <span style={{ fontSize: '20px', fontWeight: '900', width: '56px', textAlign: 'center', color: colors.navy }}>${flockAmount}</span>
                    <button onClick={() => setFlockAmount(prev => prev + 5)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>+</button>
                  </div>
                </div>
                <p style={{ fontSize: '10px', color: '#6b7280', textAlign: 'center', margin: 0 }}>Total: ${flockAmount * (flockFriends.length + 1)}</p>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
          <button onClick={handleCreate} disabled={isLoading} style={{ ...styles.gradientButton, opacity: isLoading ? 0.5 : 1 }}>
            {isLoading ? <><span style={{ display: 'inline-flex', animation: 'spin 1s linear infinite' }}>{Icons.activity('white', 16)}</span> Creating...</> : <>{Icons.users('white', 16)} Create Flock</>}
          </button>
        </div>
      </div>
    );
  };

  // JOIN SCREEN
  const JoinScreen = () => (
    <div key="join-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
      <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: colors.cream, flexShrink: 0 }}>
        <button onClick={() => { setCurrentScreen('main'); setJoinCode(''); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
        <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Join a Flock</h1>
      </div>
      <div style={{ flex: 1, padding: '16px', backgroundColor: colors.cream }}>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Enter Code</label>
          <input key="join-code-input" id="join-code-input" type="text" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} placeholder="ABC123" maxLength={6} style={{ ...styles.input, fontSize: '20px', textAlign: 'center', letterSpacing: '8px', textTransform: 'uppercase' }} autoComplete="off" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '24px 0' }}>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#d1d5db' }} />
          <span style={{ color: '#9ca3af', fontSize: '12px' }}>or</span>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#d1d5db' }} />
        </div>
        <button onClick={() => {}} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontWeight: '500', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>{Icons.camera(colors.navy, 16)} Scan QR</button>
      </div>
      <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
        <button onClick={(e) => { if (joinCode.length === 6) { confirmClick(e); addXP(20); setJoinCode(''); setCurrentScreen('main'); } else { showToast('Enter a valid code', 'error'); }}} style={{ ...styles.gradientButton, position: 'relative', overflow: 'hidden' }}>Join Flock</button>
      </div>
    </div>
  );

  // EXPLORE SCREEN
  const ExploreScreen = () => (
    <div key="explore-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#e5e7eb' }}>
      {pickingVenueForCreate && (
        <div style={{ padding: '10px 14px', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.3)' }}>
          <span style={{ color: 'white', fontSize: '12px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.mapPin('white', 14)} Tap venue to select</span>
          <button onClick={() => { setPickingVenueForCreate(false); if (pickingVenueForDm) { setPickingVenueForDm(false); setCurrentTab('chats'); setCurrentScreen('dmDetail'); } else if (pickingVenueForFlockId) { setSelectedFlockId(pickingVenueForFlockId); setPickingVenueForFlockId(null); setCurrentTab('chats'); setCurrentScreen('chatDetail'); } else { setCurrentScreen('create'); } }} style={{ backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '12px', padding: '4px 12px', color: 'white', fontSize: '11px', cursor: 'pointer', fontWeight: '500', transition: 'all 0.2s ease' }}>Cancel</button>
        </div>
      )}

      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', zIndex: 20, flexShrink: 0 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input key="search-input" id="search-input" type="text" value={venueQuery} onChange={(e) => handleVenueQueryChange(e.target.value)} placeholder="Search restaurants, bars, venues..." style={{ width: '100%', padding: '12px 14px 12px 38px', borderRadius: '14px', backgroundColor: '#f8fafc', border: `2px solid ${venueQuery ? colors.navy : '#e2e8f0'}`, fontSize: '13px', outline: 'none', boxSizing: 'border-box', transition: 'all 0.2s ease', fontWeight: '500' }} autoComplete="off" />
          <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', transition: 'all 0.2s ease' }}>{Icons.search(venueQuery ? colors.navy : '#94a3b8', 16)}</span>
        </div>
        {venueQuery && (
          <button onClick={() => { setVenueQuery(''); setVenueResults([]); setShowSearchDropdown(false); setShowSearchResults(false); setActiveVenue(null); const lat = parseFloat(localStorage.getItem('flock_user_lat')); const lng = parseFloat(localStorage.getItem('flock_user_lng')); if (lat && lng) { setMapVenuesLoaded(false); loadVenuesAtLocation(lat, lng); } else { setMapVenuesLoaded(false); requestUserLocation(false); } }} title="Clear search" style={{ width: '42px', height: '42px', borderRadius: '14px', border: 'none', backgroundColor: '#f1f5f9', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease', flexShrink: 0 }}>{Icons.x('#64748b', 18)}</button>
        )}
        <button onClick={() => { setMapVenuesLoaded(false); setVenueQuery(''); setVenueResults([]); setShowSearchDropdown(false); setShowSearchResults(false); setActiveVenue(null); requestUserLocation(true); }} title="Near Me" style={{ width: '42px', height: '42px', borderRadius: '14px', border: 'none', background: locationLoading ? `linear-gradient(135deg, ${colors.teal}, ${colors.skyBlue})` : `linear-gradient(135deg, ${colors.teal}, #0d9488)`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(20,184,166,0.3)', transition: 'all 0.2s ease', animation: locationLoading ? 'spin 1s linear infinite' : 'none' }}>{Icons.crosshair('white', 18)}</button>
        <button onClick={() => setShowConnectPanel(true)} style={{ width: '42px', height: '42px', borderRadius: '14px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(13,40,71,0.25)', transition: 'all 0.2s ease' }}>{Icons.users('white', 18)}</button>
      </div>

      {/* Location loading overlay */}
      {locationLoading && !mapVenuesLoaded && (
        <div style={{ position: 'relative', zIndex: 25, backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', padding: '16px 0', textAlign: 'center' }}>
          <div style={{ display: 'inline-block', width: '24px', height: '24px', border: `3px solid #e5e7eb`, borderTopColor: colors.teal, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ fontSize: '12px', color: '#6b7280', margin: '8px 0 0', fontWeight: '500' }}>Finding venues near you...</p>
        </div>
      )}

      {/* Search Results Overlay */}
      {showSearchDropdown && (venueSearching || venueResults.length > 0 || (venueQuery.trim().length >= 2 && !venueSearching && venueResults.length === 0)) && (
        <div style={{ position: 'relative', zIndex: 30, backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', maxHeight: '260px', overflowY: 'auto' }}>
          {venueSearching && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ display: 'inline-block', width: '20px', height: '20px', border: `3px solid #e5e7eb`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              <p style={{ fontSize: '11px', color: '#6b7280', margin: '8px 0 0' }}>Searching venues...</p>
            </div>
          )}
          {!venueSearching && venueResults.length > 0 && (
            <div style={{ padding: '4px 12px 8px' }}>
              {/* View All — first thing you see */}
              <button
                onClick={() => { setShowSearchResults(true); setShowSearchDropdown(false); }}
                style={{ width: '100%', padding: '11px 14px', borderRadius: '12px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', margin: '4px 0 8px', transition: 'all 0.2s', boxShadow: '0 2px 8px rgba(13,40,71,0.2)' }}
              >
                {Icons.filter('white', 13)}
                <span style={{ fontSize: '13px', fontWeight: '700', color: 'white' }}>See All Results ({venueResults.length})</span>
                {Icons.arrowRight('white', 14)}
              </button>
              {venueResults.slice(0, 4).map((venue) => (
                <button
                  key={venue.place_id}
                  onClick={() => {
                    setShowSearchDropdown(false);
                    // Pan map to this venue if it's in our markers
                    if (window.__flockPanToVenue) window.__flockPanToVenue(venue.place_id);
                    openVenueDetail(venue.place_id, { name: venue.name, formatted_address: venue.formatted_address, place_id: venue.place_id, rating: venue.rating, price_level: venue.price_level, photo_url: venue.photo_url });
                  }}
                  style={{ width: '100%', padding: '10px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', borderRadius: '12px', backgroundColor: '#f8fafc', cursor: 'pointer', textAlign: 'left', marginBottom: '6px', transition: 'background-color 0.15s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#eef2ff'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#f8fafc'; }}
                >
                  {venue.photo_url ? (
                    <img src={venue.photo_url} alt="" style={{ width: '48px', height: '48px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect fill="#1a3a5c" width="48" height="48" rx="10"/></svg>'); }} />
                  ) : (
                    <div style={{ width: '48px', height: '48px', borderRadius: '10px', backgroundColor: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.mapPin(colors.navyMid, 20)}</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '700', fontSize: '13px', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px', flexWrap: 'wrap' }}>
                      {venue.rating && <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>{venue.rating} ★</span>}
                      {venue.user_ratings_total > 0 && <span style={{ fontSize: '10px', color: '#9ca3af' }}>({venue.user_ratings_total})</span>}
                      {venue.price_level && <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600' }}>{'$'.repeat(venue.price_level)}</span>}
                      {userLocation && venue.location && (() => {
                        const dLat = (venue.location.latitude - userLocation.lat) * Math.PI / 180;
                        const dLng = (venue.location.longitude - userLocation.lng) * Math.PI / 180;
                        const a = Math.sin(dLat/2)**2 + Math.cos(userLocation.lat*Math.PI/180)*Math.cos(venue.location.latitude*Math.PI/180)*Math.sin(dLng/2)**2;
                        const dist = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                        return <span style={{ fontSize: '10px', color: colors.teal, fontWeight: '600' }}>{dist < 1 ? `${Math.round(dist*1000)}m` : `${dist.toFixed(1)}km`}</span>;
                      })()}
                    </div>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.formatted_address}</p>
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '3px' }}>
                    {Icons.chevronRight(colors.navyMid, 16)}
                  </div>
                </button>
              ))}
            </div>
          )}
          {!venueSearching && venueQuery.trim().length >= 2 && venueResults.length === 0 && (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>No venues found. Try a different search.</p>
            </div>
          )}
        </div>
      )}

      {/* Premium Map */}
      <div onClick={() => { setShowSearchDropdown(false); }} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Real Google Maps */}
        <GoogleMapView
          venues={allVenues}
          filterCategory={category}
          userLocation={userLocation}
          activeVenue={activeVenue}
          setActiveVenue={setActiveVenue}
          getCategoryColor={getCategoryColor}
          pickingVenueForCreate={pickingVenueForCreate}
          setPickingVenueForCreate={setPickingVenueForCreate}
          setSelectedVenueForCreate={setSelectedVenueForCreate}
          setCurrentScreen={setCurrentScreen}
          openVenueDetail={openVenueDetail}
          flockMemberLocations={flockMemberLocations}
          calcDistance={calcDistance}
        />

        {/* Live location sharing indicator on map */}
        {sharingLocationForFlock && (
          <div style={{
            position: 'absolute', top: '8px', left: '8px', right: '8px',
            padding: '8px 12px', borderRadius: '14px',
            background: 'linear-gradient(135deg, #059669, #047857)',
            display: 'flex', alignItems: 'center', gap: '8px',
            zIndex: 35, boxShadow: '0 2px 12px rgba(5,150,105,0.4)',
          }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#34d399', animation: 'pulse 2s ease-in-out infinite', boxShadow: '0 0 6px #34d399', flexShrink: 0 }} />
            <p style={{ fontSize: '11px', fontWeight: '600', color: 'white', margin: 0, flex: 1 }}>
              Live location · {Object.keys(flockMemberLocations).length > 0 ? `${Object.keys(flockMemberLocations).length} member${Object.keys(flockMemberLocations).length > 1 ? 's' : ''} nearby` : 'Waiting for others...'}
            </p>
            <button onClick={stopLocationSharing} style={{ padding: '4px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: '10px', fontWeight: '600', cursor: 'pointer' }}>Stop</button>
          </div>
        )}

        {/* Floating "See All Results" on map */}
        {allVenues.length > 0 && !activeVenue && !showConnectPanel && !pickingVenueForCreate && (
          <button
            onClick={() => { setShowSearchResults(true); setShowSearchDropdown(false); }}
            style={{ position: 'absolute', bottom: '14px', right: '12px', padding: '8px 14px', borderRadius: '12px', border: 'none', background: 'white', color: colors.navy, fontSize: '12px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', zIndex: 35, transition: 'all 0.2s ease' }}
          >
            {Icons.filter(colors.navy, 13)} View All {allVenues.length} Results
          </button>
        )}

        {/* Find Your People Panel */}
        {showConnectPanel && (
          <div style={{ position: 'absolute', left: '8px', right: '8px', top: '8px', backgroundColor: 'white', borderRadius: '16px', boxShadow: '0 4px 24px rgba(0,0,0,0.2)', zIndex: 40, maxHeight: '70%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <h2 style={{ fontSize: '14px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.users(colors.navy, 16)} Find Your People</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button onClick={() => { setShowConnectPanel(false); setConnectSearch(''); setConnectResults([]); setCurrentScreen('addFriends'); }} style={{ padding: '4px 10px', borderRadius: '10px', backgroundColor: colors.cream, border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: '600', color: colors.navy }}>See All</button>
                <button onClick={() => { setShowConnectPanel(false); setConnectSearch(''); setConnectResults([]); }} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 14)}</button>
              </div>
            </div>

            {/* Search input */}
            <div style={{ padding: '8px 12px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  value={connectSearch}
                  onChange={(e) => handleConnectSearch(e.target.value)}
                  placeholder="Search by name or email..."
                  style={{ width: '100%', padding: '10px 12px 10px 34px', borderRadius: '10px', border: `1.5px solid ${connectSearch ? colors.navy : '#e2e8f0'}`, fontSize: '13px', outline: 'none', boxSizing: 'border-box', backgroundColor: '#f8fafc', fontWeight: '500', transition: 'all 0.2s ease' }}
                  autoComplete="off"
                />
                <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(connectSearch ? colors.navy : '#94a3b8', 14)}</span>
                {connectSearch && (
                  <button onClick={() => { setConnectSearch(''); setConnectResults([]); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#94a3b8', 14)}</button>
                )}
              </div>
            </div>

            {/* Results */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
              {connectSearching && (
                <div style={{ textAlign: 'center', padding: '20px 0' }}>
                  <div style={{ display: 'inline-block', width: '16px', height: '16px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '8px' }}>Searching...</span>
                </div>
              )}

              {!connectSearching && connectSearch.trim().length >= 1 && connectResults.length === 0 && (
                <p style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center', padding: '20px 0', margin: 0 }}>No users found for "{connectSearch}"</p>
              )}

              {!connectSearching && connectResults.length > 0 && connectResults.map(user => {
                const status = friendStatuses[user.id] || 'none';
                return (
                  <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '12px', backgroundColor: colors.cream, marginBottom: '8px' }}>
                    <div style={{ width: '42px', height: '42px', borderRadius: '21px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                      {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '42px', height: '42px', borderRadius: '21px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: '700', fontSize: '13px', color: colors.navy, margin: 0 }}>{user.name}</p>
                      <p style={{ fontSize: '10px', color: '#6b7280', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</p>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      {status === 'accepted' ? (
                        <span style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: '#d1fae5', color: '#047857', fontSize: '11px', fontWeight: '700' }}>Friends</span>
                      ) : status === 'pending' ? (
                        <span style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: '#e5e7eb', color: '#6b7280', fontSize: '11px', fontWeight: '700' }}>Pending</span>
                      ) : (
                        <button onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', backgroundColor: colors.navy, color: 'white', fontSize: '11px', fontWeight: '700', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add Friend</button>
                      )}
                      <button onClick={() => {
                        setShowConnectPanel(false); setConnectSearch(''); setConnectResults([]);
                        startNewDmWithUser(user);
                      }} style={{ padding: '6px 12px', borderRadius: '20px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontSize: '11px', fontWeight: '700', cursor: 'pointer' }}>Message</button>
                    </div>
                  </div>
                );
              })}

              {!connectSearching && connectSearch.trim().length === 0 && (
                <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>{Icons.search(colors.navy, 22)}</div>
                  <p style={{ fontSize: '13px', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Search for people</p>
                  <p style={{ fontSize: '11px', color: '#9ca3af', margin: 0 }}>Find friends by name or email</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Venue Popup with AI Crowd Forecast */}
        {activeVenue && !showConnectPanel && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', bottom: '12px', left: '8px', right: '8px', backgroundColor: 'white', borderRadius: '16px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)', zIndex: 45, overflow: 'hidden', maxHeight: 'calc(100% - 24px)', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <div style={{ height: '56px', background: `linear-gradient(135deg, ${getCategoryColor(activeVenue.category)}, ${activeVenue.crowd > 70 ? colors.red : colors.navy})`, position: 'relative', padding: '8px 12px', display: 'flex', alignItems: 'flex-end' }}>
              <button onClick={() => setActiveVenue(null)} style={{ position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 14)}</button>
              <div style={{ color: 'white' }}>
                <h3 style={{ fontSize: '14px', fontWeight: '900', margin: 0 }}>{activeVenue.name}</h3>
                <p style={{ fontSize: '10px', opacity: 0.8, margin: 0 }}>{activeVenue.type} • {activeVenue.price}</p>
              </div>
              <div style={{ position: 'absolute', bottom: '8px', right: '40px', display: 'flex', alignItems: 'center', gap: '2px', backgroundColor: 'rgba(255,255,255,0.2)', padding: '2px 6px', borderRadius: '10px' }}>
                {Icons.party('#fbbf24', 10)}
                <span style={{ color: 'white', fontSize: '10px', fontWeight: 'bold', marginLeft: '2px' }}>{activeVenue.stars}</span>
              </div>
            </div>
            <div style={{ padding: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: '#6b7280', marginBottom: '8px' }}>
                {Icons.mapPin('#6b7280', 12)}
                <span>{activeVenue.addr}</span>
              </div>

              {/* AI Crowd Forecast Widget */}
              <div style={{ backgroundColor: '#f9fafb', borderRadius: '12px', padding: '10px', marginBottom: '10px', border: '1px solid rgba(13,40,71,0.08)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {Icons.robot(colors.navy, 14)}
                    <span style={{ fontSize: '11px', fontWeight: 'bold', color: colors.navy }}>AI Crowd Forecast</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: '#22C55E', animation: 'pulse 2s ease-in-out infinite' }} />
                    <span style={{ fontSize: '9px', color: '#22C55E', fontWeight: '500' }}>LIVE</span>
                    <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '10px', backgroundColor: '#dbeafe', color: '#1d4ed8', fontWeight: '600' }}>87% accuracy</span>
                  </div>
                </div>

                {/* Crowd Meter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ width: '50px', height: '50px', borderRadius: '25px', background: `conic-gradient(${activeVenue.crowd > 70 ? colors.red : activeVenue.crowd > 40 ? colors.amber : colors.teal} ${activeVenue.crowd * 3.6}deg, #e5e7eb 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                      <span style={{ fontSize: '14px', fontWeight: '900', color: activeVenue.crowd > 70 ? colors.red : activeVenue.crowd > 40 ? colors.amber : colors.teal }}>{activeVenue.crowd}%</span>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>{activeVenue.crowd > 70 ? 'Very Busy' : activeVenue.crowd > 40 ? 'Moderate' : 'Not Busy'}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0' }}>Capacity: ~{Math.round(activeVenue.crowd * 1.5)} / 150 people</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {Icons.clock(colors.teal, 10)}
                      <span style={{ fontSize: '10px', fontWeight: 'bold', color: colors.teal }}>Best time: {activeVenue.best}</span>
                    </div>
                  </div>
                </div>

                {/* Hourly Forecast Graph */}
                <div style={{ marginBottom: '10px' }}>
                  <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Hourly Forecast</p>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '40px' }}>
                    {[30, 35, 45, 55, 70, 85, 90, 80, 65, 50, 35, 25].map((h, i) => (
                      <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                        <div style={{ width: '100%', height: `${h * 0.4}px`, borderRadius: '2px', backgroundColor: h > 70 ? colors.red : h > 40 ? colors.amber : colors.teal, opacity: i === 5 ? 1 : 0.6 }} />
                        <span style={{ fontSize: '7px', color: '#9ca3af' }}>{6 + i}p</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Peak Time Prediction */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                  <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '8px', padding: '6px 8px', border: '1px solid rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.trendingUp(colors.red, 10)}
                      <span style={{ fontSize: '8px', color: '#6b7280', textTransform: 'uppercase' }}>Peak</span>
                    </div>
                    <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>10-11 PM</span>
                  </div>
                  <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '8px', padding: '6px 8px', border: '1px solid rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.zap(colors.amber, 10)}
                      <span style={{ fontSize: '8px', color: '#6b7280', textTransform: 'uppercase' }}>Wait</span>
                    </div>
                    <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>{activeVenue.crowd > 70 ? '15-20 min' : activeVenue.crowd > 40 ? '5-10 min' : 'No wait'}</span>
                  </div>
                </div>

                {/* Similar Venues */}
                <div>
                  <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Quieter Options</p>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {allVenues.filter(v => v.id !== activeVenue.id && v.category === activeVenue.category).slice(0, 2).map(v => (
                      <button key={v.id} onClick={() => setActiveVenue(v)} style={{ flex: 1, padding: '6px', backgroundColor: 'white', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '8px', cursor: 'pointer', textAlign: 'left' }}>
                        <p style={{ fontSize: '10px', fontWeight: '600', color: colors.navy, margin: 0 }}>{v.name}</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: v.crowd > 70 ? colors.red : v.crowd > 40 ? colors.amber : colors.teal }} />
                          <span style={{ fontSize: '9px', color: '#6b7280' }}>{v.crowd}% full</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '6px' }}>
                {pickingVenueForCreate ? (
                  <button onClick={(e) => {
                    confirmClick(e);
                    const venueData = { ...activeVenue, addr: activeVenue.addr || activeVenue.formatted_address, lat: activeVenue.location?.latitude, lng: activeVenue.location?.longitude };
                    // If picking for a DM, pin venue and go back to DM
                    if (pickingVenueForDm) {
                      const v = { name: venueData.name, addr: venueData.addr, place_id: venueData.place_id, rating: venueData.stars || venueData.rating, photo_url: venueData.photo_url };
                      setDmPinnedVenue(v);
                      dmPinVenue(selectedDmId, v);
                      setActiveVenue(null);
                      setPickingVenueForCreate(false);
                      setPickingVenueForDm(false);
                      setCurrentTab('chats');
                      setCurrentScreen('dmDetail');
                    } else if (pickingVenueForFlockId) {
                      updateFlockVenue(pickingVenueForFlockId, venueData);
                      setActiveVenue(null);
                      setPickingVenueForCreate(false);
                      setSelectedFlockId(pickingVenueForFlockId);
                      setPickingVenueForFlockId(null);
                      setCurrentTab('chats');
                      setCurrentScreen('chatDetail');
                    } else {
                      setSelectedVenueForCreate(venueData);
                      setActiveVenue(null);
                      setPickingVenueForCreate(false);
                      setCurrentScreen('create');
                    }
                  }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', backgroundColor: colors.teal, color: 'white', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', position: 'relative', overflow: 'hidden' }}>{Icons.check('white', 14)} Select</button>
                ) : (
                  <button onClick={(e) => { confirmClick(e); setSelectedVenueForCreate({ ...activeVenue, addr: activeVenue.addr || activeVenue.formatted_address, lat: activeVenue.location?.latitude, lng: activeVenue.location?.longitude }); setActiveVenue(null); setCurrentScreen('create'); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', position: 'relative', overflow: 'hidden' }}>{Icons.users('white', 14)} Start Flock Here</button>
                )}
                {activeVenue.place_id && (
                  <button onClick={() => { openVenueDetail(activeVenue.place_id, { name: activeVenue.name, formatted_address: activeVenue.addr, place_id: activeVenue.place_id, rating: activeVenue.stars, photo_url: activeVenue.photo_url }); }} style={{ width: '40px', height: '40px', borderRadius: '8px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.eye(colors.navy, 18)}</button>
                )}
                <button onClick={(e) => { confirmClick(e); addEventToCalendar(`Visit ${activeVenue.name}`, activeVenue.name, new Date(), '8 PM', getCategoryColor(activeVenue.category)); }} style={{ width: '40px', height: '40px', borderRadius: '8px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>{Icons.calendar(colors.navy, 18)}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Categories */}
      <div style={{ padding: '8px', backgroundColor: 'white', boxShadow: '0 -2px 4px rgba(0,0,0,0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto' }}>
          {[
              { id: 'All', icon: () => Icons.sparkles(category === 'All' ? colors.cream : colors.navy, 14) },
              { id: 'Food', icon: () => Icons.pizza(category === 'Food' ? colors.cream : colors.food, 14) },
              { id: 'Nightlife', icon: () => Icons.cocktail(category === 'Nightlife' ? colors.cream : colors.nightlife, 14) },
              { id: 'Live Music', icon: () => Icons.music(category === 'Live Music' ? colors.cream : colors.music, 14) },
              { id: 'Sports', icon: () => Icons.sports(category === 'Sports' ? colors.cream : colors.sports, 14) }
            ].map(c => (
            <button key={c.id} onClick={() => {
              setActiveVenue(null);
              if (c.id === 'All') {
                // Reset: reload all venues near user (not just popular chains)
                setCategory('All');
                setVenueQuery('');
                requestUserLocation(true); // force reload all nearby venues + re-center map
                return;
              }
              // Category filter — uses types-based matching
              const matches = allVenues.filter(v => {
                const t = (v.types || []).join(' ').toLowerCase();
                const nm = (v.name || '').toLowerCase();
                if (c.id === 'Food') return t.includes('restaurant') || t.includes('cafe') || t.includes('food') || t.includes('bakery') || t.includes('bar') || v.category === 'Food';
                if (c.id === 'Nightlife') return t.includes('bar') || t.includes('night_club') || t.includes('club') || t.includes('liquor') || v.category === 'Nightlife';
                if (c.id === 'Live Music') return t.includes('music') || t.includes('concert') || t.includes('performing_arts') || nm.includes('music') || v.category === 'Live Music';
                if (c.id === 'Sports') return t.includes('stadium') || t.includes('gym') || t.includes('sports') || t.includes('bowling') || v.category === 'Sports';
                return true;
              });
              if (matches.length === 0) {
                               setCategory('All');
                return;
              }
              setCategory(c.id);
            }} style={{ padding: '8px 12px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: category === c.id ? colors.navy : 'white', color: category === c.id ? colors.cream : colors.navy, fontWeight: 'bold', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              {c.icon()} {c.id}
            </button>
          ))}
        </div>
      </div>

      <SafetyButton />
      <BottomNav />
    </div>
  );

  // CALENDAR SCREEN (simplified)
  const CalendarScreen = () => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const daysInMonth = getDaysInMonth(calendarMonth);
    const firstDay = getFirstDayOfMonth(calendarMonth);
    const selectedDateStr = formatDateStr(selectedDate);
    const eventsOnSelected = getEventsForDate(selectedDateStr);
    const today = new Date();
    const todayStr = formatDateStr(today);
    const isToday = (dateStr) => dateStr === todayStr;

    // Event categories
    const eventCategories = [
      { id: 'social', label: 'Social', color: colors.navy, icon: Icons.users },
      { id: 'dining', label: 'Dining', color: colors.food, icon: Icons.pizza },
      { id: 'nightlife', label: 'Nightlife', color: colors.nightlife, icon: Icons.cocktail },
      { id: 'music', label: 'Music', color: colors.music, icon: Icons.music },
    ];

    // Upcoming events (next 7 days)
    const getUpcomingEvents = () => {
      const upcoming = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const events = getEventsForDate(formatDateStr(d));
        events.forEach(e => upcoming.push({ ...e, dayLabel: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' }) }));
      }
      return upcoming.slice(0, 4);
    };

    // Weather data (mock)
    const getWeatherForDate = (dateStr) => {
      const weathers = [
        { icon: Icons.sun, temp: '72°', condition: 'Sunny' },
        { icon: Icons.cloud, temp: '65°', condition: 'Cloudy' },
        { icon: Icons.sun, temp: '78°', condition: 'Clear' },
      ];
      return weathers[Math.abs(dateStr.split('-')[2]) % 3];
    };

    const weather = getWeatherForDate(selectedDateStr);

    return (
      <div key="calendar-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 16)}</button>
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>{monthNames[calendarMonth.getMonth()]}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{calendarMonth.getFullYear()}</p>
            </div>
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowRight('white', 16)}</button>
          </div>
          {/* Today Quick Jump */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setCalendarMonth(today); setSelectedDate(today); }} style={{ flex: 1, padding: '8px', borderRadius: '10px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', fontSize: '11px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
              {Icons.zap('#F59E0B', 12)}
              Jump to Today
            </button>
          </div>
        </div>

        {/* Day names header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '8px', backgroundColor: 'white' }}>
          {dayNames.map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 'bold', color: '#9ca3af' }}>{d}</div>)}
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '0 8px 8px', backgroundColor: 'white', flexShrink: 0 }}>
          {[...Array(firstDay)].map((_, i) => <div key={`e-${i}`} style={{ height: '40px' }} />)}
          {[...Array(daysInMonth)].map((_, i) => {
            const day = i + 1;
            const dateStr = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const events = getEventsForDate(dateStr);
            const isSelected = dateStr === selectedDateStr;
            const isTodayDate = isToday(dateStr);
            const isBusy = events.length >= 2;
            return (
              <button key={day} onClick={() => setSelectedDate(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day))} style={{ height: '40px', borderRadius: '10px', border: isTodayDate && !isSelected ? `2px solid ${colors.teal}` : 'none', backgroundColor: isSelected ? colors.navy : isBusy ? 'rgba(13,40,71,0.05)' : 'transparent', color: isSelected ? 'white' : isTodayDate ? colors.teal : 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <span style={{ fontSize: '12px', fontWeight: isTodayDate || isSelected ? '700' : '500' }}>{day}</span>
                {events.length > 0 && (
                  <div style={{ display: 'flex', gap: '2px', marginTop: '2px' }}>
                    {events.slice(0, 3).map((e, idx) => <div key={idx} style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: isSelected ? 'white' : e.color }} />)}
                  </div>
                )}
                {isBusy && !isSelected && <div style={{ position: 'absolute', top: '2px', right: '4px', width: '6px', height: '6px', borderRadius: '3px', backgroundColor: colors.amber }} />}
              </button>
            );
          })}
        </div>

        {/* Events section */}
        <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {/* Weather widget for selected date */}
          <div style={{ ...styles.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', background: 'linear-gradient(135deg, #dbeafe, #e0f2fe)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {weather.icon('#F59E0B', 28)}
              <div>
                <p style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: 0 }}>{weather.temp}</p>
                <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{weather.condition}</p>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { weekday: 'long' })}</p>
              <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
            </div>
          </div>

          {/* Selected date events header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.calendar(colors.navy, 14)}
              {isToday(selectedDateStr) ? 'Today' : selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </h3>
            <button onClick={() => setShowAddEvent(true)} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              {Icons.plus('white', 12)} Add
            </button>
          </div>

          {/* Events list */}
          {eventsOnSelected.length > 0 ? eventsOnSelected.map(event => (
            <div key={event.id} style={{ ...styles.card, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '10px', background: `linear-gradient(135deg, ${event.color}, ${event.color}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {Icons.party('white', 20)}
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>{event.title}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                  <span style={{ fontSize: '10px', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.clock('#6b7280', 10)} {event.time}</span>
                  <span style={{ fontSize: '10px', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin('#6b7280', 10)} {event.venue}</span>
                </div>
                {event.members > 1 && <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginTop: '4px' }}>{Icons.users('#6b7280', 10)}<span style={{ fontSize: '9px', color: '#6b7280' }}>{event.members} going</span></div>}
              </div>
              <button onClick={() => setCalendarEvents(calendarEvents.filter(e => e.id !== event.id))} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: '#fee2e2', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.red, 14)}</button>
            </div>
          )) : (
            <div style={{ textAlign: 'center', padding: '24px' }}>
              {Icons.calendar('#9ca3af', 40)}
              <p style={{ color: '#9ca3af', fontSize: '14px', margin: '8px 0 0' }}>No events scheduled</p>
            </div>
          )}

          {/* Add event form */}
          {showAddEvent && (
            <div style={{ ...styles.card, marginTop: '12px', border: `2px solid ${colors.navy}` }}>
              <h4 style={{ fontSize: '13px', fontWeight: 'bold', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.plus(colors.navy, 14)} New Event</h4>
              <input key="event-title" id="event-title" type="text" value={newEventTitle} onChange={(e) => setNewEventTitle(e.target.value)} placeholder="Event title" style={{ ...styles.input, marginBottom: '8px' }} autoComplete="off" />
              <input key="event-venue" id="event-venue" type="text" value={newEventVenue} onChange={(e) => setNewEventVenue(e.target.value)} placeholder="Venue (optional)" style={{ ...styles.input, marginBottom: '10px' }} autoComplete="off" />
              {/* Event categories */}
              <p style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', marginBottom: '6px' }}>Category</p>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                {eventCategories.map(cat => (
                  <button key={cat.id} style={{ padding: '6px 10px', borderRadius: '16px', border: `1px solid ${cat.color}`, backgroundColor: 'white', cursor: 'pointer', fontSize: '10px', color: cat.color, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {cat.icon(cat.color, 12)} {cat.label}
                  </button>
                ))}
              </div>
              {/* Repeat toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid #eee', marginBottom: '10px' }}>
                <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.repeat(colors.navy, 12)} Repeat weekly</span>
                <Toggle on={false} onChange={() => {}} />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => { setShowAddEvent(false); setNewEventTitle(''); setNewEventVenue(''); }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={(e) => { if (newEventTitle.trim()) { confirmClick(e); addEventToCalendar(newEventTitle, newEventVenue || 'TBD', selectedDate, '7:00 PM', colors.navy); setNewEventTitle(''); setNewEventVenue(''); setShowAddEvent(false); }}} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', position: 'relative', overflow: 'hidden' }}>{Icons.check('white', 14)} Add</button>
              </div>
            </div>
          )}

          {/* Upcoming events preview */}
          {!showAddEvent && getUpcomingEvents().length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h4 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.trendingUp(colors.navy, 12)} Coming Up</h4>
              {getUpcomingEvents().map((event, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '10px', backgroundColor: 'white', marginBottom: '6px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ width: '4px', height: '32px', borderRadius: '2px', backgroundColor: event.color }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{event.title}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{event.dayLabel} at {event.time}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // CHAT LIST SCREEN — redesigned with pin & reorder
  const ChatListScreen = () => {
    const totalConversations = flocks.length + directMessages.length;

    // Sort flocks: pinned first, then by custom order, then default
    const sortedFlocks = [...flocks].sort((a, b) => {
      const aPinned = pinnedFlockIds.includes(a.id);
      const bPinned = pinnedFlockIds.includes(b.id);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      const aOrder = flockOrder.indexOf(a.id);
      const bOrder = flockOrder.indexOf(b.id);
      if (aOrder !== -1 && bOrder !== -1) return aOrder - bOrder;
      if (aOrder !== -1) return -1;
      if (bOrder !== -1) return 1;
      return 0;
    });

    const filteredDms = directMessages.filter(dm => !chatSearch || dm.name.toLowerCase().includes(chatSearch.toLowerCase()));
    const filteredFlocks = sortedFlocks.filter(f => !chatSearch || f.name.toLowerCase().includes(chatSearch.toLowerCase()));

    const moveFlockUp = (flockId) => {
      setFlockOrder(prev => {
        const ids = prev.length > 0 ? [...prev] : sortedFlocks.map(f => f.id);
        const idx = ids.indexOf(flockId);
        if (idx <= 0) return ids;
        [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
        return ids;
      });
    };

    const moveFlockDown = (flockId) => {
      setFlockOrder(prev => {
        const ids = prev.length > 0 ? [...prev] : sortedFlocks.map(f => f.id);
        const idx = ids.indexOf(flockId);
        if (idx === -1 || idx >= ids.length - 1) return ids;
        [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
        return ids;
      });
    };

    const togglePin = (flockId) => {
      setPinnedFlockIds(prev => prev.includes(flockId) ? prev.filter(id => id !== flockId) : [...prev, flockId]);
    };

    return (
      <div key="chat-list-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#f0ede6' }}>
        {/* Header */}
        <div style={{ padding: '20px 16px 16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ fontSize: '22px', fontWeight: '900', color: 'white', margin: 0, letterSpacing: '-0.3px' }}>Messages</h1>
              <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', margin: '2px 0 0', fontWeight: '500' }}>{totalConversations} conversation{totalConversations !== 1 ? 's' : ''}</p>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => setEditingFlockList(!editingFlockList)} style={{ width: '36px', height: '36px', borderRadius: '12px', border: editingFlockList ? '2px solid white' : 'none', backgroundColor: editingFlockList ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}>
                {Icons.gripVertical('white', 16)}
              </button>
              <button onClick={() => setShowNewDmModal(true)} style={{ width: '36px', height: '36px', borderRadius: '12px', border: 'none', backgroundColor: colors.cream, color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                {Icons.plus(colors.navy, 16)}
              </button>
              <button onClick={() => { setShowChatSearch(!showChatSearch); if (!showChatSearch) setTimeout(() => chatListSearchRef.current?.focus(), 50); }} style={{ width: '36px', height: '36px', borderRadius: '12px', border: 'none', backgroundColor: showChatSearch ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}>
                {Icons.search('white', 16)}
              </button>
            </div>
          </div>

          {/* Search bar */}
          {showChatSearch && (
            <div style={{ marginTop: '12px', position: 'relative' }}>
              <input ref={chatListSearchRef} type="text" value={chatSearch} onChange={(e) => setChatSearch(e.target.value)} placeholder="Search conversations..." style={{ width: '100%', padding: '10px 14px 10px 36px', borderRadius: '12px', border: 'none', fontSize: '13px', fontWeight: '500', outline: 'none', backgroundColor: 'rgba(255,255,255,0.95)', boxSizing: 'border-box' }} autoComplete="off" />
              <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search('#94a3b8', 14)}</span>
            </div>
          )}

          {/* Edit mode banner */}
          {editingFlockList && (
            <div style={{ marginTop: '10px', padding: '8px 12px', backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.9)', fontWeight: '600', flex: 1 }}>Tap arrows to reorder, pin to keep on top</span>
              <button onClick={() => setEditingFlockList(false)} style={{ background: 'none', border: 'none', color: colors.cream, cursor: 'pointer', fontSize: '12px', fontWeight: '700', padding: '2px 8px' }}>Done</button>
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 12px' }}>
          {/* Direct Messages section */}
          {filteredDms.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 4px 8px' }}>
                <span style={{ fontSize: '11px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Direct Messages</span>
                <div style={{ flex: 1, height: '1px', backgroundColor: '#e5e7eb' }} />
              </div>
              {filteredDms.map((dm) => {
                const lastMsg = dm.messages?.length > 0 ? dm.messages[dm.messages.length - 1] : (dm.lastMessage ? { text: dm.lastMessage, sender: dm.lastMessageIsYou ? 'You' : dm.name } : null);
                return (
                  <button key={`dm-${dm.userId}`} onClick={() => { setSelectedDmId(dm.userId); setCurrentScreen('dmDetail'); setDirectMessages(prev => prev.map(d => d.userId === dm.userId ? { ...d, unread: 0 } : d)); }} style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: '16px', padding: '12px 14px', marginBottom: '6px', border: dm.unread ? `1.5px solid ${colors.navy}15` : '1px solid #f0f0f0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', transition: 'all 0.2s', boxShadow: dm.unread ? '0 2px 12px rgba(13,40,71,0.08)' : '0 1px 4px rgba(0,0,0,0.03)' }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{ width: '46px', height: '46px', borderRadius: '23px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '700', color: 'white', overflow: 'hidden' }}>
                        {dm.image ? <img src={dm.image} alt="" style={{ width: '46px', height: '46px', borderRadius: '23px', objectFit: 'cover' }} /> : (dm.name?.[0]?.toUpperCase() || '?')}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                        <h3 style={{ fontSize: '14px', fontWeight: dm.unread ? '800' : '600', color: colors.navy, margin: 0 }}>{dm.name}</h3>
                        {dm.lastMessageTime && <span style={{ fontSize: '10px', color: '#b0b0b0', fontWeight: '500' }}>{new Date(dm.lastMessageTime).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {lastMsg?.sender === 'You' && <span style={{ flexShrink: 0 }}>{Icons.checkDouble('#22C55E', 11)}</span>}
                        <p style={{ fontSize: '12px', color: dm.unread ? colors.navy : '#8b8b8b', fontWeight: dm.unread ? '500' : '400', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastMsg?.sender === 'You' ? 'You: ' : ''}{lastMsg?.text || 'Start a conversation'}</p>
                      </div>
                    </div>
                    {dm.unread > 0 && (
                      <div style={{ width: '20px', height: '20px', borderRadius: '10px', background: 'linear-gradient(135deg, #EF4444, #DC2626)', color: 'white', fontSize: '10px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {dm.unread}
                      </div>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {/* Pending Flock Invites */}
          {pendingFlockInvites.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 4px 8px' }}>
                <span style={{ fontSize: '11px', fontWeight: '700', color: '#F59E0B', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pending Invites</span>
                <div style={{ flex: 1, height: '1px', backgroundColor: '#e5e7eb' }} />
                <span style={{ width: '18px', height: '18px', borderRadius: '9px', background: 'linear-gradient(135deg, #F59E0B, #D97706)', color: 'white', fontSize: '10px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{pendingFlockInvites.length}</span>
              </div>
              {pendingFlockInvites.map((f) => (
                <div key={`invite-${f.id}`} style={{ backgroundColor: 'white', borderRadius: '16px', padding: '12px 14px', marginBottom: '6px', border: '1.5px solid #FDE68A', display: 'flex', alignItems: 'center', gap: '12px', boxShadow: '0 2px 12px rgba(245,158,11,0.08)' }}>
                  <div style={{ width: '46px', height: '46px', borderRadius: '14px', background: 'linear-gradient(135deg, #F59E0B, #D97706)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(245,158,11,0.2)', flexShrink: 0 }}>
                    {Icons.mail('white', 20)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ fontSize: '14px', fontWeight: '700', color: colors.navy, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</h3>
                    <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Invited by {f.host}</p>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button onClick={() => handleDeclineFlockInvite(f.id)} style={{ width: '32px', height: '32px', borderRadius: '10px', border: '1.5px solid #e5e7eb', backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {Icons.x('#9ca3af', 14)}
                    </button>
                    <button onClick={() => handleAcceptFlockInvite(f.id)} style={{ width: '32px', height: '32px', borderRadius: '10px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {Icons.check('white', 14)}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Flocks section */}
          {filteredFlocks.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 4px 8px' }}>
                <span style={{ fontSize: '11px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Flocks</span>
                <div style={{ flex: 1, height: '1px', backgroundColor: '#e5e7eb' }} />
                <span style={{ fontSize: '10px', color: '#b0b0b0', fontWeight: '500' }}>{filteredFlocks.length}</span>
              </div>
              {filteredFlocks.map((f, idx) => {
                const isPinned = pinnedFlockIds.includes(f.id);
                const lastMsg = f.messages[f.messages.length - 1];
                const hasUnread = f.messages.some(m => m.sender !== 'You' && !m.read);
                const statusColor = f.status === 'confirmed' ? '#22C55E' : f.status === 'voting' ? '#F59E0B' : colors.teal;
                const statusLabel = f.status === 'confirmed' ? 'Confirmed' : f.status === 'voting' ? 'Voting' : 'Planning';

                return (
                  <div key={`flock-${f.id}`} style={{ display: 'flex', alignItems: 'stretch', gap: '0', marginBottom: '6px' }}>
                    {/* Edit controls */}
                    {editingFlockList && (
                      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px', paddingRight: '6px', flexShrink: 0 }}>
                        <button onClick={(e) => { e.stopPropagation(); moveFlockUp(f.id); }} style={{ width: '26px', height: '26px', borderRadius: '8px', border: 'none', backgroundColor: idx === 0 ? '#f3f4f6' : 'white', cursor: idx === 0 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', opacity: idx === 0 ? 0.4 : 1 }}>
                          {Icons.chevronUp(colors.navy, 14)}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); moveFlockDown(f.id); }} style={{ width: '26px', height: '26px', borderRadius: '8px', border: 'none', backgroundColor: idx === filteredFlocks.length - 1 ? '#f3f4f6' : 'white', cursor: idx === filteredFlocks.length - 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', opacity: idx === filteredFlocks.length - 1 ? 0.4 : 1 }}>
                          {Icons.chevronDown(colors.navy, 14)}
                        </button>
                      </div>
                    )}

                    {/* Flock card */}
                    <button onClick={() => { if (editingFlockList) return; setSelectedFlockId(f.id); setCurrentScreen('chatDetail'); simulateTyping(); }} style={{ flex: 1, textAlign: 'left', backgroundColor: isPinned ? `${colors.navy}06` : 'white', borderRadius: '16px', padding: '12px 14px', border: isPinned ? `1.5px solid ${colors.navy}18` : '1px solid #f0f0f0', cursor: editingFlockList ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: '12px', transition: 'all 0.2s', boxShadow: isPinned ? '0 2px 12px rgba(13,40,71,0.06)' : '0 1px 4px rgba(0,0,0,0.03)', position: 'relative', overflow: 'hidden' }}>
                      {/* Avatar */}
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <div style={{ width: '46px', height: '46px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(13,40,71,0.2)' }}>
                          {Icons.users('white', 20)}
                        </div>
                        {/* Status dot */}
                        <div style={{ position: 'absolute', bottom: '-1px', right: '-1px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: statusColor, border: '2px solid white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {f.status === 'confirmed' && <span style={{ fontSize: '7px', color: 'white', fontWeight: '900' }}>&#10003;</span>}
                        </div>
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                            {isPinned && <span style={{ flexShrink: 0 }}>{Icons.pinFilled(colors.navy, 11)}</span>}
                            <h3 style={{ fontSize: '14px', fontWeight: hasUnread ? '800' : '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</h3>
                          </div>
                          <span style={{ fontSize: '10px', color: hasUnread ? colors.navy : '#b0b0b0', fontWeight: hasUnread ? '600' : '400', flexShrink: 0, marginLeft: '8px' }}>{getRelativeTime(lastMsg?.time)}</span>
                        </div>

                        {/* Venue + status row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                          <span style={{ fontSize: '10px', fontWeight: '600', color: statusColor, backgroundColor: `${statusColor}15`, padding: '1px 6px', borderRadius: '6px' }}>{statusLabel}</span>
                          {f.venue && f.venue !== 'TBD' && (
                            <span style={{ fontSize: '10px', color: '#8b8b8b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.venue}</span>
                          )}
                          <span style={{ fontSize: '10px', color: '#b0b0b0', marginLeft: 'auto', flexShrink: 0 }}>{f.memberCount || 0} {Icons.users('#b0b0b0', 10)}</span>
                        </div>

                        {/* Last message */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          {lastMsg?.sender === 'You' && <span style={{ flexShrink: 0 }}>{Icons.checkDouble('#22C55E', 11)}</span>}
                          <p style={{ fontSize: '12px', color: hasUnread ? colors.navy : '#8b8b8b', fontWeight: hasUnread ? '500' : '400', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastMsg ? `${lastMsg.sender === 'You' ? 'You' : lastMsg.sender}: ${lastMsg.text}` : 'No messages yet'}</p>
                        </div>
                      </div>

                      {/* Pin button (edit mode) or unread badge */}
                      {editingFlockList ? (
                        <button onClick={(e) => { e.stopPropagation(); togglePin(f.id); }} style={{ width: '32px', height: '32px', borderRadius: '10px', border: 'none', backgroundColor: isPinned ? `${colors.navy}12` : '#f5f5f5', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                          {isPinned ? Icons.pinFilled(colors.navy, 16) : Icons.pin('#9ca3af', 16)}
                        </button>
                      ) : hasUnread && (
                        <div style={{ width: '10px', height: '10px', borderRadius: '5px', backgroundColor: colors.navy, flexShrink: 0 }} />
                      )}
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {/* Empty state */}
          {filteredDms.length === 0 && filteredFlocks.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', opacity: 0.6 }}>
              {Icons.messageSquare('#9ca3af', 40)}
              <p style={{ fontSize: '14px', color: '#9ca3af', fontWeight: '600', margin: '12px 0 4px' }}>{chatSearch ? 'No results found' : 'No conversations yet'}</p>
              <p style={{ fontSize: '12px', color: '#b0b0b0', margin: 0 }}>{chatSearch ? 'Try a different search' : 'Create a flock or send a DM to get started'}</p>
            </div>
          )}
        </div>
        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // CHAT DETAIL SCREEN - Enhanced with location cards, timestamps, typing indicators, and image sharing
  const ChatDetailScreen = () => {
    const flock = getSelectedFlock();
    const reactions = ['❤️', '👍', '😂', '🔥'];

    return (
      <div key="chat-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
        <div style={{ padding: '6px 10px 5px 4px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button onClick={() => { setCurrentScreen('main'); setChatInput(''); setReplyingTo(null); setShowFlockMenu(false); setShowLeaveConfirm(false); setShowChatSearch(false); setChatSearch(''); setShowVotePanel(false); }} style={{ width: '34px', height: '34px', borderRadius: '17px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.arrowLeft('white', 20)}</button>
            <h2 style={{ flex: 1, fontWeight: '800', color: 'white', fontSize: '15px', margin: 0, lineHeight: '1.3', minWidth: 0 }}>{flock.name}</h2>
            <button onClick={() => { setShowVotePanel(true); loadPopularVenues(); }} style={{ height: '34px', borderRadius: '17px', border: 'none', backgroundColor: flock.status === 'voting' ? colors.teal : 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '0 12px', fontSize: '12px', fontWeight: '700', flexShrink: 0 }}>{Icons.vote('white', 14)} Vote</button>
            <button onClick={() => { setShowFlockInviteModal(true); setFlockInviteSelected([]); setFlockInviteSearch(''); setFlockInviteResults([]); }} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.userPlus('white', 15)}</button>
            <button onClick={() => setShowChatSearch(!showChatSearch)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: showChatSearch ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.search('white', 15)}</button>
            <button onClick={() => setShowChatPool(true)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: colors.cream, color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.dollar(colors.navy, 15)}</button>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button onClick={() => setShowFlockMenu(!showFlockMenu)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.moreVertical('white', 16)}</button>
              {showFlockMenu && (
                <div style={{ position: 'absolute', top: '38px', right: 0, backgroundColor: 'white', borderRadius: '14px', boxShadow: '0 8px 30px rgba(0,0,0,0.18)', minWidth: '180px', zIndex: 60, overflow: 'hidden', border: '1px solid rgba(0,0,0,0.06)' }}>
                  <button onClick={() => { setShowFlockMenu(false); setShowLeaveConfirm(true); }} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', backgroundColor: 'white', cursor: 'pointer', fontSize: '14px', fontWeight: '600', color: '#EF4444' }}>
                    {Icons.doorOpen('#EF4444', 16)} Leave Flock
                  </button>
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', paddingLeft: '34px', marginTop: '2px' }}>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>{flock.members?.length || flock.memberCount || 0} members</span>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>•</span>
            {isTyping ? <span style={{ fontSize: '11px', color: '#86EFAC', fontWeight: '600' }}>{typingUser} is typing...</span> : <><span style={{ width: '5px', height: '5px', borderRadius: '3px', backgroundColor: '#22c55e', boxShadow: '0 0 6px #22c55e' }} /><span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>online</span></>}
          </div>
        </div>

        {/* Dismiss menu on outside tap */}
        {showFlockMenu && (
          <div onClick={() => setShowFlockMenu(false)} style={{ position: 'absolute', inset: 0, zIndex: 55 }} />
        )}

        {/* Chat message search bar */}
        {showChatSearch && (
          <div style={{ padding: '8px 12px', backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', flexShrink: 0, animation: 'fadeIn 0.2s ease-out' }}>
            <div style={{ position: 'relative' }}>
              <input
                ref={chatSearchRef}
                type="text"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search messages in this flock..."
                style={{ width: '100%', padding: '10px 36px 10px 36px', borderRadius: '20px', border: `2px solid ${chatSearch ? colors.navy : '#e2e8f0'}`, fontSize: '13px', outline: 'none', boxSizing: 'border-box', backgroundColor: '#f8fafc', fontWeight: '500', transition: 'border-color 0.2s' }}
                autoComplete="off"
              />
              <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(chatSearch ? colors.navy : '#94a3b8', 14)}</span>
              <button onClick={() => { setShowChatSearch(false); setChatSearch(''); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#94a3b8', 16)}</button>
            </div>
            {chatSearch.trim() && (
              <p style={{ fontSize: '10px', color: '#6b7280', margin: '6px 0 0 4px', fontWeight: '500' }}>
                {flock.messages.filter(m => {
                  const q = chatSearch.toLowerCase();
                  return (m.text || '').toLowerCase().includes(q) || (m.sender || '').toLowerCase().includes(q);
                }).length} messages found
              </p>
            )}
          </div>
        )}

        {/* Pinned Venue Banner — shows which venue this flock is at */}
        {flock.venue && flock.venue !== 'TBD' ? (
          <div style={{ padding: '10px 14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.teal}12)`, borderBottom: `1px solid ${colors.creamDark}`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {flock.venuePhoto ? (
                <img src={flock.venuePhoto} alt="" style={{ width: '52px', height: '52px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52"><rect fill="#1a3a5c" width="52" height="52" rx="12"/></svg>'); }} />
              ) : (
                <div style={{ width: '52px', height: '52px', borderRadius: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.2)' }}>
                  {Icons.mapPin('white', 22)}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: '800', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venue}</h4>
                  {flock.venueRating && (
                    <span style={{ fontSize: '11px', fontWeight: '700', color: '#F59E0B', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                      {Icons.starFilled('#F59E0B', 11)} {flock.venueRating}
                    </span>
                  )}
                </div>
                {flock.venueAddress && (
                  <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venueAddress}</p>
                )}
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button
                  onClick={() => {
                    setCurrentTab('explore');
                    setCurrentScreen('main');
                    if (flock.venueId || flock.venueLat) {
                      setTimeout(() => {
                        if (window.__flockPanToVenue) {
                          window.__flockPanToVenue({ place_id: flock.venueId, lat: flock.venueLat, lng: flock.venueLng, name: flock.venue, address: flock.venueAddress, rating: flock.venueRating, photo_url: flock.venuePhoto });
                        }
                      }, 300);
                    }
                  }}
                  style={{ padding: '8px 10px', borderRadius: '10px', border: 'none', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, color: 'white', fontSize: '10px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', boxShadow: '0 2px 8px rgba(20,184,166,0.3)' }}
                >
                  {Icons.mapPin('white', 12)} Map
                </button>
                <button
                  onClick={() => { setPickingVenueForCreate(true); setPickingVenueForFlockId(flock.id); setCurrentTab('explore'); setCurrentScreen('main'); }}
                  style={{ padding: '8px 10px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, background: 'white', color: colors.navy, fontSize: '10px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px' }}
                >
                  Change
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { setPickingVenueForCreate(true); setPickingVenueForFlockId(flock.id); setCurrentTab('explore'); setCurrentScreen('main'); }}
            style={{ margin: '0', padding: '10px 14px', background: `linear-gradient(135deg, ${colors.cream}, white)`, borderBottom: `1px solid ${colors.creamDark}`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', width: '100%', flexShrink: 0 }}
          >
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', border: `2px dashed ${colors.teal}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.mapPin(colors.teal, 18)}
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <p style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>Add a Venue</p>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: '1px 0 0' }}>Pick a spot for this flock</p>
            </div>
            <div style={{ color: colors.teal, fontWeight: '700', fontSize: '20px' }}>+</div>
          </button>
        )}

        {/* Live location sharing banner */}
        {flock.status === 'confirmed' && !sharingLocationForFlock && !locationBannerDismissed[flock.id] && (
          <div style={{ padding: '10px 14px', background: 'linear-gradient(135deg, #ecfdf5, #d1fae5)', borderBottom: '1px solid #a7f3d0', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px', animation: 'fadeIn 0.3s ease-out' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '18px', background: 'linear-gradient(135deg, #10b981, #059669)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(16,185,129,0.3)' }}>
              {Icons.mapPin('white', 18)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: '12px', fontWeight: '700', color: '#065f46', margin: 0 }}>Share your location with the group?</p>
              <p style={{ fontSize: '10px', color: '#047857', margin: '1px 0 0' }}>Members can see where everyone is on the map</p>
            </div>
            <button onClick={(e) => { confirmClick(e); startSharingLocation(flock.id); }} style={{ padding: '6px 12px', borderRadius: '14px', border: 'none', background: '#10b981', color: 'white', fontSize: '11px', fontWeight: '700', cursor: 'pointer', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>Share</button>
            <button onClick={() => { setLocationBannerDismissed(prev => { const next = { ...prev, [flock.id]: true }; localStorage.setItem('flock_loc_dismissed', JSON.stringify(next)); return next; }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', flexShrink: 0 }}>{Icons.x('#6b7280', 14)}</button>
          </div>
        )}

        {/* Active location sharing indicator */}
        {sharingLocationForFlock === flock.id && (
          <div style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #059669, #047857)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#34d399', animation: 'pulse 2s ease-in-out infinite', boxShadow: '0 0 6px #34d399' }} />
            <p style={{ fontSize: '11px', fontWeight: '600', color: 'white', margin: 0, flex: 1 }}>Sharing location with {flock.name}</p>
            {Object.keys(flockMemberLocations).length > 0 && (
              <span style={{ fontSize: '10px', color: '#a7f3d0', fontWeight: '500' }}>{Object.keys(flockMemberLocations).length} sharing</span>
            )}
            <button onClick={stopLocationSharing} style={{ padding: '4px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: '10px', fontWeight: '600', cursor: 'pointer' }}>Stop</button>
          </div>
        )}

        <div onScroll={() => document.activeElement?.blur()} style={{ flex: 1, padding: '16px', overflowY: 'auto', background: `linear-gradient(180deg, ${colors.cream} 0%, rgba(245,240,230,0.8) 100%)`, scrollBehavior: 'smooth' }}>
          {showChatSearch && chatSearch.trim() && flock.messages.filter(m => {
            const q = chatSearch.toLowerCase();
            return (m.text || '').toLowerCase().includes(q) || (m.sender || '').toLowerCase().includes(q);
          }).length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <p style={{ fontSize: '14px', color: '#9ca3af', fontWeight: '500' }}>No messages match "{chatSearch}"</p>
            </div>
          )}
          {(showChatSearch && chatSearch.trim()
            ? flock.messages.filter(m => {
                const q = chatSearch.toLowerCase();
                return (m.text || '').toLowerCase().includes(q) || (m.sender || '').toLowerCase().includes(q);
              })
            : flock.messages
          ).map((m, idx) => (
            <div
              key={m.id}
              onTouchStart={(e) => handleTouchStart(m.id, e)}
              onTouchMove={(e) => handleTouchMove(m.id, e)}
              onTouchEnd={(e) => handleTouchEnd(m.id, m, e)}
              style={{
                display: 'flex',
                gap: '10px',
                marginBottom: '16px',
                flexDirection: m.sender === 'You' ? 'row-reverse' : 'row',
                position: 'relative',
                transform: swipeState.id === m.id ? `translateX(${swipeState.x}px)` : 'translateX(0)',
                transition: swipeState.id === m.id ? 'none' : 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
                animation: 'fadeIn 0.3s ease-out'
              }}
            >
              {/* Swipe hint icon */}
              {swipeState.id === m.id && swipeState.x > 20 && (
                <div style={{ position: 'absolute', left: '-30px', top: '50%', transform: 'translateY(-50%)', opacity: Math.min(swipeState.x / 50, 1), transition: 'opacity 0.2s ease' }}>
                  {Icons.reply(colors.navy, 20)}
                </div>
              )}
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '17px', background: m.sender === 'You' ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : 'white', border: m.sender === 'You' ? 'none' : '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', color: m.sender === 'You' ? 'white' : colors.navy, boxShadow: m.sender === 'You' ? '0 3px 10px rgba(13,40,71,0.25)' : '0 2px 6px rgba(0,0,0,0.06)', transition: 'transform 0.2s ease' }}>
                  {m.sender[0]}
                </div>
                {m.sender !== 'You' && idx === 0 && <div style={{ position: 'absolute', bottom: '-1px', right: '-1px', width: '10px', height: '10px', borderRadius: '5px', backgroundColor: '#22C55E', border: '2px solid white' }} />}
              </div>
              <div style={{ maxWidth: '72%', display: 'flex', flexDirection: 'column', alignItems: m.sender === 'You' ? 'flex-end' : 'flex-start' }}>
                {/* Sender name and timestamp */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', padding: '0 4px' }}>
                  <span style={{ fontSize: '11px', color: colors.navy, fontWeight: '600' }}>{m.sender}</span>
                  <span style={{ fontSize: '10px', color: '#9ca3af' }}>•</span>
                  <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: '500' }}>{m.time || getRelativeTime(m.time)}</span>
                </div>

                {/* Image message */}
                {m.image && (
                  <div style={{
                    borderRadius: '16px',
                    overflow: 'hidden',
                    boxShadow: '0 4px 15px rgba(0,0,0,0.1)',
                    marginBottom: '4px'
                  }}>
                    <img src={m.image} alt="Shared" style={{ width: '200px', height: '150px', objectFit: 'cover', display: 'block' }} />
                  </div>
                )}

                {/* Venue Card message */}
                {m.message_type === 'venue_card' && m.venue_data && (
                  <VenueCard
                    venue={m.venue_data}
                    colors={colors}
                    Icons={Icons}
                    getCategoryColor={getCategoryColor}
                    onViewDetails={() => {
                      const vc = m.venue_data;
                      const pid = vc.place_id;
                      setCurrentTab('explore');
                      setCurrentScreen('main');
                      if (pid || vc.lat || vc.latitude) {
                        const lat = vc.lat || vc.latitude;
                        const lng = vc.lng || vc.longitude;
                        setTimeout(() => {
                          if (window.__flockPanToVenue) {
                            window.__flockPanToVenue({ place_id: pid, lat, lng, name: vc.name, address: vc.addr || vc.formatted_address, rating: vc.stars || vc.rating, photo_url: vc.photo_url });
                          }
                        }, 300);
                      }
                    }}
                    onVote={() => {
                      const existingVote = flock.votes.find(v => v.venue === m.venue_data.name);
                      if (existingVote) {
                        const newVotes = flock.votes.map(v => ({
                          ...v,
                          voters: v.venue === m.venue_data.name
                            ? (v.voters.includes('You') ? v.voters : [...v.voters, 'You'])
                            : v.voters.filter(x => x !== 'You')
                        }));
                        updateFlockVotes(selectedFlockId, newVotes);
                      } else {
                        const newVotes = [...flock.votes, { venue: m.venue_data.name, type: m.venue_data.type, voters: ['You'] }];
                        updateFlockVotes(selectedFlockId, newVotes);
                      }
                                           addXP(10);
                    }}
                  />
                )}

                {/* Regular text message */}
                {m.text && m.message_type !== 'venue_card' && (
                  <div
                    onClick={() => setShowReactionPicker(showReactionPicker === m.id ? null : m.id)}
                    style={{
                      borderRadius: '18px',
                      padding: '10px 14px',
                      background: m.sender === 'You' ? `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyMid} 100%)` : 'rgba(255,255,255,0.95)',
                      backdropFilter: 'blur(10px)',
                      WebkitBackdropFilter: 'blur(10px)',
                      color: m.sender === 'You' ? 'white' : colors.navy,
                      borderBottomRightRadius: m.sender === 'You' ? '4px' : '18px',
                      borderBottomLeftRadius: m.sender === 'You' ? '18px' : '4px',
                      boxShadow: m.sender === 'You' ? '0 3px 12px rgba(13,40,71,0.2)' : '0 2px 10px rgba(0,0,0,0.05)',
                      border: m.sender === 'You' ? 'none' : '1px solid rgba(255,255,255,0.8)',
                      cursor: 'pointer',
                      position: 'relative',
                      transition: 'transform 0.15s ease, box-shadow 0.15s ease'
                    }}
                  >
                    <p style={{ fontSize: '14px', lineHeight: '1.45', margin: 0, fontWeight: '500' }}>{showChatSearch && chatSearch.trim() && m.text && m.text.toLowerCase().includes(chatSearch.toLowerCase()) ? (() => {
                      const q = chatSearch.toLowerCase();
                      const i = m.text.toLowerCase().indexOf(q);
                      return <>{m.text.slice(0, i)}<mark style={{ backgroundColor: '#fde047', color: 'inherit', borderRadius: '2px', padding: '0 1px' }}>{m.text.slice(i, i + chatSearch.length)}</mark>{m.text.slice(i + chatSearch.length)}</>;
                    })() : m.text}</p>
                    {m.sender === 'You' && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px', gap: '2px', alignItems: 'center' }}>
                        {Icons.checkDouble('#86EFAC', 12)}
                      </div>
                    )}
                  </div>
                )}

                {/* Reaction picker */}
                {showReactionPicker === m.id && (
                  <div style={{
                    display: 'flex',
                    gap: '4px',
                    marginTop: '6px',
                    padding: '6px 10px',
                    backgroundColor: 'white',
                    borderRadius: '24px',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                    animation: 'reactionPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
                  }}>
                    {reactions.map(r => (
                      <button
                        key={r}
                        onClick={(e) => { e.stopPropagation(); addReactionToMessage(flock.id, m.id, r); }}
                        style={{
                          background: 'none',
                          border: 'none',
                          fontSize: '20px',
                          cursor: 'pointer',
                          padding: '6px',
                          borderRadius: '10px',
                          transition: 'transform 0.15s ease, background-color 0.15s ease'
                        }}
                      >{r}</button>
                    ))}
                    <button onClick={(e) => { e.stopPropagation(); setReplyingTo(m); setShowReactionPicker(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px' }}>{Icons.reply('#6b7280', 18)}</button>
                  </div>
                )}

                {/* Reactions display */}
                {m.reactions && m.reactions.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {m.reactions.map((r, i) => (
                      <span
                        key={i}
                        className="reaction-pop"
                        style={{
                          fontSize: '14px',
                          backgroundColor: 'white',
                          borderRadius: '14px',
                          padding: '4px 8px',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                          border: '1px solid rgba(0,0,0,0.05)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        {r}
                        <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: '500' }}>1</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Enhanced typing indicator with user name — fixed height to prevent layout shift */}
          <div style={{ height: '58px', overflow: 'hidden', opacity: isTyping ? 1 : 0, transition: 'opacity 0.2s ease', pointerEvents: isTyping ? 'auto' : 'none' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'white', border: '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', color: colors.navy }}>{typingUser?.[0] || 'A'}</div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '11px', color: colors.navy, fontWeight: '600', marginBottom: '4px', paddingLeft: '4px' }}>{typingUser || 'Someone'}</span>
                <div style={{ padding: '12px 16px', backgroundColor: 'white', borderRadius: '18px', borderBottomLeftRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out infinite', opacity: 0.7 }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out 0.2s infinite', opacity: 0.7 }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out 0.4s infinite', opacity: 0.7 }} />
                </div>
              </div>
            </div>
          </div>
          <div ref={chatEndRef} />
        </div>

        {/* Reply bar */}
        {replyingTo && (
          <div style={{ padding: '10px 16px', backgroundColor: 'rgba(13,40,71,0.05)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '10px', animation: 'slideUp 0.2s ease-out' }}>
            <div style={{ width: '3px', height: '36px', backgroundColor: colors.navy, borderRadius: '2px' }} />
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>Replying to {replyingTo.sender}</p>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyingTo.text}</p>
            </div>
            <button onClick={() => setReplyingTo(null)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(0,0,0,0.05)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.2s ease' }}>{Icons.x('#6b7280', 16)}</button>
          </div>
        )}

        {/* Image preview bar */}
        {showImagePreview && pendingImage && (
          <div style={{ padding: '12px 16px', backgroundColor: 'rgba(13,40,71,0.05)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '12px', animation: 'slideUp 0.2s ease-out' }}>
            <div style={{ position: 'relative' }}>
              <img src={pendingImage} alt="Preview" style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} />
              <button
                onClick={() => { setPendingImage(null); setShowImagePreview(false); }}
                style={{ position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px', borderRadius: '11px', backgroundColor: colors.red, border: '2px solid white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {Icons.x('white', 12)}
              </button>
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>Ready to send</p>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0' }}>Tap send to share this image</p>
            </div>
            <button
              onClick={() => shareImageToChat(selectedFlockId)}
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '22px',
                border: 'none',
                background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
                color: 'white',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 3px 10px rgba(13,40,71,0.25)'
              }}
            >
              {Icons.send('white', 18)}
            </button>
          </div>
        )}

        {/* Input area */}
        <div style={{ padding: '10px 12px', backgroundColor: 'rgba(255,255,255,0.98)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0, boxShadow: '0 -4px 20px rgba(0,0,0,0.03)' }}>
          <button onClick={() => setShowCameraPopup(true)} style={{ width: '38px', height: '38px', borderRadius: '19px', border: 'none', backgroundColor: 'rgba(13,40,71,0.08)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease', flexShrink: 0 }}>
            {Icons.camera('#6b7280', 18)}
          </button>
          <input ref={chatGalleryInputRef} type="file" accept="image/*" onChange={handleChatImageSelect} style={{ display: 'none' }} />
          <button onClick={() => { if (sharingLocationForFlock === flock.id) { stopLocationSharing(); } else { const otherMembers = (flock.members || []).filter(m => m.id !== authUser?.id).length; if (otherMembers === 0) { showToast('No one else in this flock to share with', 'error'); return; } startSharingLocation(flock.id); } }} style={{ width: '38px', height: '38px', borderRadius: '19px', border: 'none', backgroundColor: sharingLocationForFlock === flock.id ? '#10b981' : 'rgba(13,40,71,0.08)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease', flexShrink: 0 }}>{Icons.mapPin(sharingLocationForFlock === flock.id ? 'white' : '#6b7280', 16)}</button>
          <input key="chat-input" id="chat-input" type="text" value={chatInput} onChange={handleChatInputChange} onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()} placeholder={replyingTo ? 'Reply...' : 'Type a message...'} style={{ flex: 1, padding: '12px 16px', borderRadius: '22px', backgroundColor: 'rgba(243,244,246,0.9)', border: '1px solid rgba(0,0,0,0.05)', fontSize: '14px', outline: 'none', fontWeight: '500', transition: 'all 0.2s ease' }} autoComplete="off" />
          {chatInput ? (
            <button onClick={sendChatMessage} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 10px rgba(13,40,71,0.25)', transition: 'all 0.2s ease' }}>{Icons.send('white', 18)}</button>
          ) : (
            <button onClick={() => {}} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 10px rgba(13,40,71,0.25)', transition: 'all 0.2s ease' }}>{Icons.mic('white', 18)}</button>
          )}
        </div>

        {/* Camera options popup */}
        {showCameraPopup && (
          <div onClick={() => setShowCameraPopup(false)} style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', zIndex: 60 }}>
            <div onClick={e => e.stopPropagation()} style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', paddingBottom: '28px' }}>
              <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: '#d1d5db', margin: '0 auto 16px' }} />
              <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Add Photo</h3>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button onClick={() => openCameraViewfinder('flock')} style={{ flex: 1, padding: '16px', borderRadius: '16px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', transition: 'all 0.2s ease' }}>
                  {Icons.camera(colors.navy, 28)}
                  <span style={{ fontSize: '13px', fontWeight: '700', color: colors.navy }}>Take Photo</span>
                </button>
                <button onClick={() => { setShowCameraPopup(false); setTimeout(() => chatGalleryInputRef.current?.click(), 100); }} style={{ flex: 1, padding: '16px', borderRadius: '16px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', transition: 'all 0.2s ease' }}>
                  {Icons.image(colors.navy, 28)}
                  <span style={{ fontSize: '13px', fontWeight: '700', color: colors.navy }}>Gallery</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cash Pool Modal */}
        {showChatPool && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Cash Pool</h2>
                <button onClick={() => setShowChatPool(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '16px' }}>
                <button onClick={() => setChatPoolAmount(prev => Math.max(5, prev - 5))} style={{ width: '44px', height: '44px', borderRadius: '22px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer', fontSize: '18px', transition: 'all 0.2s ease' }}>−</button>
                <span style={{ fontSize: '36px', fontWeight: '900', width: '100px', textAlign: 'center', color: colors.navy }}>${chatPoolAmount}</span>
                <button onClick={() => setChatPoolAmount(prev => prev + 5)} style={{ width: '44px', height: '44px', borderRadius: '22px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer', fontSize: '18px', transition: 'all 0.2s ease' }}>+</button>
              </div>
              <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', marginBottom: '20px' }}>Per person • Total: ${chatPoolAmount * (flock.members?.length || flock.memberCount || 1)}</p>
              <button onClick={(e) => { confirmClick(e); addMessageToFlock(selectedFlockId, { id: Date.now(), sender: 'You', time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), text: `💰 Pool: $${chatPoolAmount}/person`, reactions: [] }); setShowChatPool(false); }} style={{ ...styles.gradientButton, padding: '14px', position: 'relative', overflow: 'hidden' }}>Create Pool</button>
            </div>
          </div>
        )}

        {/* Vote Panel */}
        {showVotePanel && (() => {
          const myVote = flock.votes.find(v => v.voters.includes('You'))?.venue || null;
          const totalVoters = new Set(flock.votes.flatMap(v => v.voters)).size;
          const isCreator = flock.creatorId && String(flock.creatorId) === String(authUser?.id);

          const handleQuickVote = (venueName, venueType) => {
            const existingVote = flock.votes.find(v => v.venue === venueName);
            if (existingVote) {
              if (existingVote.voters.includes('You')) return; // already voted
              const newVotes = flock.votes.map(v => ({
                ...v,
                voters: v.venue === venueName
                  ? [...v.voters, 'You']
                  : v.voters.filter(x => x !== 'You')
              }));
              updateFlockVotes(selectedFlockId, newVotes);
            } else {
              const newVotes = [...flock.votes.map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') })), { venue: venueName, type: venueType || 'Venue', voters: ['You'] }];
              updateFlockVotes(selectedFlockId, newVotes);
            }
                       addXP(10);
          };

          const handleUnvote = () => {
            const newVotes = flock.votes.map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') })).filter(v => v.voters.length > 0);
            updateFlockVotes(selectedFlockId, newVotes);
          };

          const handleConfirmVenue = (venueName) => {
            const venueObj = allVenues.find(v => v.name === venueName);
            updateFlockVenue(selectedFlockId, {
              name: venueName,
              addr: venueObj?.addr || venueObj?.formatted_address || '',
              place_id: venueObj?.place_id || null,
              lat: venueObj?.location?.latitude || null,
              lng: venueObj?.location?.longitude || null,
              photo_url: venueObj?.photo_url || null,
              rating: venueObj?.stars || venueObj?.rating || null,
            });
            setShowVotePanel(false);
                     };

          // Ensure assigned venue is in votes list
          const assignedVenue = flock.venue && flock.venue !== 'TBD' ? flock.venue : null;
          const votesWithAssigned = assignedVenue && !flock.votes.find(v => v.venue === assignedVenue)
            ? [{ venue: assignedVenue, type: 'Assigned', voters: [] }, ...flock.votes]
            : flock.votes;

          // Sort: assigned venue always first, then by vote count
          const sortedVotes = [...votesWithAssigned].sort((a, b) => {
            if (a.venue === assignedVenue && b.venue !== assignedVenue) return -1;
            if (b.venue === assignedVenue && a.venue !== assignedVenue) return 1;
            return b.voters.length - a.voters.length;
          });

          // Popular chains nearby that aren't already vote options
          const suggestedVenues = popularVenues.filter(v => !votesWithAssigned.find(fv => fv.venue === v.name)).slice(0, 8);

          return (
            <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
              <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '80%', overflowY: 'auto' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <div>
                    <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.vote(colors.navy, 20)} Vote for a Venue</h2>
                    <p style={{ fontSize: '11px', color: '#9ca3af', margin: '2px 0 0' }}>{totalVoters} vote{totalVoters !== 1 ? 's' : ''} cast{myVote ? ` • You voted for ${myVote}` : ''}</p>
                  </div>
                  <button onClick={() => setShowVotePanel(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
                </div>

                {/* Current votes */}
                {sortedVotes.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                    {sortedVotes.map((v, idx) => {
                      const isAssigned = v.venue === assignedVenue;
                      const isMyVote = v.voters.includes('You');
                      const votePercent = totalVoters > 0 ? Math.round((v.voters.length / totalVoters) * 100) : 0;
                      const isLeading = !isAssigned && idx === 0 && v.voters.length > 0;
                      const iconBg = isAssigned
                        ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`
                        : isLeading ? `linear-gradient(135deg, ${colors.teal}, #0d9488)` : `linear-gradient(135deg, ${colors.navy}15, ${colors.navy}25)`;
                      return (
                        <button key={v.venue} onClick={(e) => { confirmClick(e); isMyVote ? handleUnvote() : handleQuickVote(v.venue, v.type); }} style={{ width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: '14px', border: isAssigned ? `2px solid ${colors.navy}` : isMyVote ? `2px solid ${colors.navy}` : '1.5px solid #e5e7eb', backgroundColor: isAssigned ? `${colors.navy}05` : isMyVote ? `${colors.navy}06` : 'white', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'all 0.2s' }}>
                          {/* Progress bar background */}
                          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${votePercent}%`, backgroundColor: isMyVote ? `${colors.navy}10` : '#f8fafc', transition: 'width 0.4s ease', borderRadius: '14px' }} />
                          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              {isAssigned ? Icons.mapPin('white', 16) : isLeading ? Icons.flame('#fff', 18) : Icons.mapPin(colors.navy, 16)}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <h4 style={{ fontSize: '14px', fontWeight: '700', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.venue}</h4>
                                {isAssigned && <span style={{ fontSize: '9px', fontWeight: '700', color: 'white', backgroundColor: colors.navy, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Assigned</span>}
                                {isLeading && <span style={{ fontSize: '9px', fontWeight: '700', color: colors.teal, backgroundColor: `${colors.teal}15`, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Leading</span>}
                              </div>
                              <p style={{ fontSize: '11px', color: '#9ca3af', margin: '1px 0 0' }}>{v.voters.length > 0 ? v.voters.join(', ') : isAssigned ? 'Current flock venue — tap to vote' : 'No votes yet'}</p>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                              {v.voters.length > 0 && <span style={{ fontSize: '16px', fontWeight: '900', color: isMyVote ? colors.navy : '#9ca3af' }}>{v.voters.length}</span>}
                              {isMyVote && <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.check('white', 12)}</div>}
                              {isCreator && !isAssigned && (
                                <button onClick={(e) => { e.stopPropagation(); confirmClick(e); handleConfirmVenue(v.venue); }} style={{ padding: '4px 8px', borderRadius: '8px', border: 'none', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, color: 'white', fontSize: '10px', fontWeight: '700', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Confirm</button>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', backgroundColor: '#f8fafc', borderRadius: '14px', marginBottom: '16px' }}>
                    <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0, fontWeight: '500' }}>No votes yet. Be the first to suggest a venue!</p>
                  </div>
                )}

                {/* Popular chains nearby */}
                {suggestedVenues.length > 0 && (
                  <>
                    <p style={{ fontSize: '12px', fontWeight: '700', color: '#9ca3af', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Popular Chains Nearby</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {suggestedVenues.map(venue => (
                        <button key={venue.id || venue.name} onClick={(e) => { confirmClick(e); handleQuickVote(venue.name, venue.type || venue.category || 'Venue'); }} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: '12px', border: '1px solid #e5e7eb', backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.2s', position: 'relative', overflow: 'hidden' }}>
                          {venue.photo_url ? (
                            <img src={venue.photo_url} alt="" style={{ width: '36px', height: '36px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect fill="#1a3a5c" width="36" height="36" rx="8"/></svg>'); }} />
                          ) : (
                            <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              {Icons.mapPin('white', 14)}
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: '13px', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</p>
                            <p style={{ fontSize: '10px', color: '#9ca3af', margin: '1px 0 0' }}>{venue.type || venue.category}{venue.stars ? ` • ${venue.stars}★` : ''}{venue.price ? ` • ${venue.price}` : ''}</p>
                          </div>
                          <div style={{ padding: '6px 12px', borderRadius: '10px', backgroundColor: `${colors.navy}08`, color: colors.navy, fontSize: '11px', fontWeight: '700', flexShrink: 0 }}>
                            {Icons.vote(colors.navy, 12)} Vote
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Browse more button */}
                <button onClick={() => { setShowVotePanel(false); setShowVenueShareModal(true); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: '#9ca3af', fontSize: '13px', fontWeight: '600', cursor: 'pointer', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  {Icons.plus('#9ca3af', 14)} Share a venue to chat
                </button>
              </div>
            </div>
          );
        })()}

        {/* Venue Share Modal */}
        {showVenueShareModal && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.mapPin(colors.navy, 20)} Share a Venue</h2>
                <button onClick={() => setShowVenueShareModal(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
              </div>

              {/* Current venue display */}
              {flock.venue && flock.venue !== 'TBD' ? (
                <div style={{ padding: '12px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.teal}15)`, border: `2px solid ${colors.teal}40`, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {Icons.mapPin('white', 18)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: colors.teal, margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Current Venue</p>
                    <p style={{ fontSize: '14px', fontWeight: '700', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venue}</p>
                    {flock.venueAddress && <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venueAddress}</p>}
                  </div>
                  <button onClick={(e) => { confirmClick(e); shareVenueToChat(selectedFlockId, { name: flock.venue, addr: flock.venueAddress, place_id: flock.venueId, stars: flock.venueRating, photo_url: flock.venuePhoto, category: 'Food', crowd: 50, price: '$$' }); }} style={{ padding: '8px 12px', borderRadius: '10px', border: 'none', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, color: 'white', fontSize: '11px', fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap', position: 'relative', overflow: 'hidden' }}>Share This</button>
                </div>
              ) : (
                <div style={{ padding: '10px 12px', borderRadius: '12px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: '16px' }}>
                  <p style={{ fontSize: '12px', color: '#6b7280', margin: 0, fontStyle: 'italic' }}>No venue selected. Pick one below:</p>
                </div>
              )}

              <p style={{ fontSize: '12px', fontWeight: '600', color: '#6b7280', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Or select a different venue:</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {allVenues.map(venue => (
                  <button
                    key={venue.id}
                    onClick={(e) => { confirmClick(e); shareVenueToChat(selectedFlockId, venue); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px',
                      borderRadius: '14px',
                      border: '1px solid #e2e8f0',
                      backgroundColor: 'white',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.2s ease',
                      position: 'relative',
                      overflow: 'hidden'
                    }}
                  >
                    <div style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '12px',
                      background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      {venue.category === 'Food' ? Icons.pizza('white', 20) : venue.category === 'Nightlife' ? Icons.cocktail('white', 20) : venue.category === 'Live Music' ? Icons.music('white', 20) : Icons.sports('white', 20)}
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: '14px', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                      <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0' }}>{venue.type} • {venue.price}</p>
                    </div>
                    <div style={{
                      padding: '4px 10px',
                      borderRadius: '12px',
                      backgroundColor: venue.crowd > 70 ? '#FEE2E2' : venue.crowd > 40 ? '#FEF3C7' : '#D1FAE5',
                      color: venue.crowd > 70 ? colors.red : venue.crowd > 40 ? colors.amber : colors.teal,
                      fontSize: '11px',
                      fontWeight: '600'
                    }}>
                      {venue.crowd}%
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Invite Friends Modal */}
        {showFlockInviteModal && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
              <div style={{ width: '40px', height: '4px', backgroundColor: '#e5e7eb', borderRadius: '2px', margin: '0 auto 16px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: 0 }}>Invite Friends</h3>
                <button onClick={() => setShowFlockInviteModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#94a3b8', 20)}</button>
              </div>

              {/* Selected friends chips */}
              {flockInviteSelected.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
                  {flockInviteSelected.map(f => (
                    <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px 4px 4px', borderRadius: '20px', backgroundColor: colors.navy, color: 'white' }}>
                      <div style={{ width: '22px', height: '22px', borderRadius: '11px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700', overflow: 'hidden' }}>
                        {f.profile_image_url ? <img src={f.profile_image_url} alt="" style={{ width: '22px', height: '22px', borderRadius: '11px', objectFit: 'cover' }} /> : f.name[0]?.toUpperCase()}
                      </div>
                      <span style={{ fontSize: '12px', fontWeight: '600' }}>{f.name.split(' ')[0]}</span>
                      <button onClick={() => setFlockInviteSelected(prev => prev.filter(x => x.id !== f.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center' }}>{Icons.x('rgba(255,255,255,0.7)', 12)}</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Search input */}
              <div style={{ position: 'relative', marginBottom: '12px' }}>
                <input
                  type="text"
                  value={flockInviteSearch}
                  onChange={(e) => handleFlockInviteSearch(e.target.value)}
                  placeholder="Search friends..."
                  style={{ width: '100%', padding: '10px 14px 10px 36px', borderRadius: '12px', border: `2px solid ${flockInviteSearch ? colors.navy : '#e2e8f0'}`, fontSize: '13px', outline: 'none', boxSizing: 'border-box', backgroundColor: '#f8fafc', fontWeight: '500', transition: 'border-color 0.2s' }}
                  autoComplete="off"
                />
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search('#94a3b8', 14)}</span>
                {flockInviteSearch && (
                  <button onClick={() => { setFlockInviteSearch(''); setFlockInviteResults([]); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#94a3b8', 14)}</button>
                )}
              </div>

              {/* Search results */}
              {flockInviteSearching && (
                <div style={{ textAlign: 'center', padding: '10px 0' }}>
                  <div style={{ display: 'inline-block', width: '14px', height: '14px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ fontSize: '11px', color: '#6b7280', marginLeft: '6px' }}>Searching...</span>
                </div>
              )}
              {!flockInviteSearching && flockInviteResults.length > 0 && (
                <div style={{ maxHeight: '200px', overflowY: 'auto', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'white' }}>
                  {flockInviteResults
                    .filter(u => !flockInviteSelected.some(s => s.id === u.id))
                    .filter(u => !(flock?.members || []).some(m => m.id === u.id))
                    .map((friend, i, arr) => (
                      <button key={friend.id} onClick={() => setFlockInviteSelected(prev => [...prev, friend])} style={{ width: '100%', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', borderBottom: i < arr.length - 1 ? `1px solid ${colors.creamDark}` : 'none', backgroundColor: 'white', cursor: 'pointer', textAlign: 'left' }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                          {friend.profile_image_url ? <img src={friend.profile_image_url} alt="" style={{ width: '36px', height: '36px', borderRadius: '18px', objectFit: 'cover' }} /> : friend.name[0]?.toUpperCase()}
                        </div>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontWeight: '700', fontSize: '14px', color: colors.navy, margin: 0 }}>{friend.name}</p>
                        </div>
                        <div style={{ padding: '4px 10px', borderRadius: '8px', backgroundColor: colors.cream, color: colors.teal, fontSize: '11px', fontWeight: '700' }}>Add</div>
                      </button>
                    ))}
                </div>
              )}
              {!flockInviteSearching && flockInviteSearch.trim().length >= 1 && flockInviteResults.length === 0 && (
                <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '8px 0', margin: 0 }}>No friends found</p>
              )}

              {/* Send button */}
              {flockInviteSelected.length > 0 && (
                <button
                  onClick={handleSendFlockInvites}
                  disabled={flockInviteSending}
                  style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '14px', fontWeight: '800', cursor: 'pointer', marginTop: '12px', opacity: flockInviteSending ? 0.7 : 1 }}
                >
                  {flockInviteSending ? 'Sending...' : `Invite ${flockInviteSelected.length} Friend${flockInviteSelected.length > 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Leave Flock Confirmation Modal */}
        {showLeaveConfirm && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
            <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '24px', padding: '24px', width: '100%', maxWidth: '300px' }}>
              <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>{Icons.doorOpen('#EF4444', 24)}</div>
                <h3 style={{ fontSize: '16px', fontWeight: '900', color: colors.navy, margin: '0 0 8px' }}>Leave Flock?</h3>
                <p style={{ fontSize: '13px', color: '#6b7280', margin: 0, lineHeight: '1.4' }}>
                  {flock.creatorId && String(flock.creatorId) === String(authUser?.id)
                    ? `You're the creator. Leaving will delete "${flock.name}" for everyone.`
                    : `Are you sure you want to leave "${flock.name}"?`}
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => setShowLeaveConfirm(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={async () => {
                  try {
                    setIsLoading(true);
                    const flockId = flock.id;
                    await apiLeaveFlock(flockId);
                    setFlocks(prev => prev.filter(f => f.id !== flockId));
                    setShowLeaveConfirm(false);
                    setShowFlockMenu(false);
                    setCurrentScreen('main');
                    setCurrentTab('home');
                                       // Notify other members via socket
                    const sock = getSocket();
                    if (sock?.connected) {
                      sock.emit('leave_flock', flockId);
                    }
                  } catch (err) {
                    showToast(err.message || 'Failed to leave flock', 'error');
                  } finally {
                    setIsLoading(false);
                  }
                }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>
                  {isLoading ? 'Leaving...' : 'Leave'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // FLOCK DETAIL SCREEN
  const FlockDetailScreen = () => {
    const flock = getSelectedFlock();
    const myVote = flock.votes.find(v => v.voters.includes('You'))?.venue || null;

    const handleVote = (venueName) => {
      const newVotes = flock.votes.map(v => ({ ...v, voters: v.venue === venueName ? (v.voters.includes('You') ? v.voters : [...v.voters, 'You']) : v.voters.filter(x => x !== 'You') }));
      updateFlockVotes(selectedFlockId, newVotes);
      addXP(10);
         };

    return (
      <div key="flock-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        <div style={{ padding: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <button onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer' }}>←</button>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontWeight: '900', color: 'white', fontSize: '14px', margin: 0 }}>{flock.name}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{flock.host} • {flock.time}</p>
            </div>
            <button onClick={(e) => { confirmClick(e); addEventToCalendar(flock.name, flock.venue, new Date(), '9 PM'); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>{Icons.calendar('white', 16)}</button>
          </div>
          <div style={{ display: 'flex' }}>
            {flock.members.slice(0, 5).map((m, i) => (
              <div key={i} style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.3)', border: '2px solid white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 'bold', color: 'white', marginLeft: i > 0 ? '-6px' : 0 }}>{m[0]}</div>
            ))}
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', marginLeft: '8px', alignSelf: 'center' }}>{flock.members?.length || flock.memberCount || 0} going</span>
          </div>
        </div>

        <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {/* Venue Info Card */}
          {flock.venue && flock.venue !== 'TBD' && (
            <div style={{ ...styles.card, display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              {flock.venuePhoto ? (
                <img src={flock.venuePhoto} alt="" style={{ width: '52px', height: '52px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }} onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52"><rect fill="#1a3a5c" width="52" height="52" rx="10"/></svg>'); }} />
              ) : (
                <div style={{ width: '52px', height: '52px', borderRadius: '10px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.mapPin('white', 20)}</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: '700', fontSize: '13px', color: colors.navy, margin: 0 }}>{flock.venue}</p>
                {flock.venueAddress && <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.venueAddress}</p>}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
                  {flock.venueRating && <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>{flock.venueRating} ★</span>}
                  {flock.venuePriceLevel && <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600' }}>{'$'.repeat(flock.venuePriceLevel)}</span>}
                </div>
              </div>
              {flock.venueId && (
                <button onClick={() => openVenueDetail(flock.venueId, { name: flock.venue, formatted_address: flock.venueAddress, place_id: flock.venueId, rating: flock.venueRating, photo_url: flock.venuePhoto })} style={{ padding: '6px 10px', borderRadius: '10px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '10px', fontWeight: '700', cursor: 'pointer', flexShrink: 0 }}>
                  {Icons.eye('white', 12)} Details
                </button>
              )}
            </div>
          )}
          {flock.cashPool && (
            <div style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>Cash Pool</h3>
                <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', fontWeight: '500', backgroundColor: flock.cashPool.collected >= flock.cashPool.target ? '#d1fae5' : '#fef3c7', color: flock.cashPool.collected >= flock.cashPool.target ? '#047857' : '#b45309' }}>
                  ${flock.cashPool.collected}/${flock.cashPool.target}
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#e5e7eb', borderRadius: '4px', marginBottom: '8px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(flock.cashPool.collected / flock.cashPool.target) * 100}%`, background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, borderRadius: '4px', transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', boxShadow: flock.cashPool.collected >= flock.cashPool.target ? '0 0 12px rgba(13,40,71,0.4)' : 'none' }} />
              </div>
              {!flock.cashPool.paid.includes('You') ? (
                <button onClick={(e) => { confirmClick(e); makePoolPayment(selectedFlockId); }} style={{ ...styles.gradientButton, padding: '8px', position: 'relative', overflow: 'hidden' }}>Pay ${flock.cashPool.perPerson}</button>
              ) : (
                <div style={{ textAlign: 'center', padding: '4px', color: colors.teal, fontWeight: '600', fontSize: '12px' }}>✓ Paid!</div>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px' }}>Vote</h2>
          {flock.votes.map(v => (
            <button key={v.venue} onClick={() => handleVote(v.venue)} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>{v.venue}</h3>
                <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{v.type}</p>
                <p style={{ fontSize: '9px', color: colors.navyMid, margin: '2px 0 0' }}>{v.voters.join(', ')}</p>
              </div>
              <span style={{ padding: '6px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', backgroundColor: myVote === v.venue ? colors.navy : colors.cream, color: myVote === v.venue ? 'white' : colors.navy }}>
                {myVote === v.venue ? '✓ ' : ''}{v.voters.length}
              </span>
            </button>
          ))}

          <button onClick={() => setCurrentScreen('chatDetail')} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', marginTop: '12px' }}>
            <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 4px' }}>Chat</h2>
            <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>{flock.messages[flock.messages.length - 1]?.sender}: {flock.messages[flock.messages.length - 1]?.text}</p>
          </button>
        </div>

        <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
          <button onClick={() => {}} style={{ ...styles.gradientButton, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.mapPin('white', 16)} Share Location</button>
        </div>
      </div>
    );
  };

  // PROFILE SCREEN (simplified)
  const ProfileScreen = () => {
    if (profileScreen !== 'main') {
      return (
        <div key={`profile-${profileScreen}-container`} style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
          <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: 'white', flexShrink: 0 }}>
            <button onClick={() => setProfileScreen('main')} style={{ background: 'none', border: 'none', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
            <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>{profileScreen === 'edit' ? 'Edit Profile' : profileScreen === 'safety' ? 'Safety' : profileScreen === 'interests' ? 'Interests' : 'Payment'}</h1>
          </div>
          <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
            {profileScreen === 'edit' && (() => {
              const EditProfileForm = () => {
                const [editName, setEditName] = React.useState(profileName);
                const [editEmail, setEditEmail] = React.useState(authUser?.email || '');
                const [editHandle, setEditHandle] = React.useState(profileHandle);
                const [currentPw, setCurrentPw] = React.useState('');
                const [newPw, setNewPw] = React.useState('');
                const [confirmPw, setConfirmPw] = React.useState('');
                const [showCurrentPw, setShowCurrentPw] = React.useState(false);
                const [showNewPw, setShowNewPw] = React.useState(false);
                const [editError, setEditError] = React.useState('');
                const [editSuccess, setEditSuccess] = React.useState('');
                const [editLoading, setEditLoading] = React.useState(false);

                const EyeSvg = ({ show }) => (
                  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {show ? (
                      <>
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </>
                    ) : (
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    )}
                  </svg>
                );

                const handleSaveProfile = async () => {
                  setEditError('');
                  setEditSuccess('');

                  if (!editName.trim()) { setEditError('Name is required'); return; }
                  if (!editEmail.trim()) { setEditError('Email is required'); return; }
                  if (!currentPw) { setEditError('Current password is required to save changes'); return; }
                  if (newPw && newPw.length < 8) { setEditError('New password must be at least 8 characters'); return; }
                  if (newPw && newPw !== confirmPw) { setEditError('New passwords do not match'); return; }

                  setEditLoading(true);
                  try {
                    const payload = {
                      name: editName.trim(),
                      email: editEmail.trim(),
                      current_password: currentPw,
                    };
                    if (newPw) payload.new_password = newPw;

                    const data = await updateProfile(payload);
                    setProfileName(data.user.name);
                    setProfileHandle(data.user.email.split('@')[0]);
                    setEditSuccess('Profile updated successfully!');
                    setCurrentPw('');
                    setNewPw('');
                    setConfirmPw('');
                                     } catch (err) {
                    setEditError(err.message);
                  } finally {
                    setEditLoading(false);
                  }
                };

                const pwFieldStyle = { position: 'relative' };
                const eyeBtnStyle = { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' };

                return (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                      <button onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                        {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user(colors.navy, 32)}
                      </button>
                    </div>

                    {editError && (
                      <div style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 14px', marginBottom: '14px', color: colors.red, fontSize: '13px', fontWeight: '600' }}>{editError}</div>
                    )}
                    {editSuccess && (
                      <div style={{ backgroundColor: 'rgba(20,184,166,0.1)', border: '1px solid rgba(20,184,166,0.3)', borderRadius: '10px', padding: '10px 14px', marginBottom: '14px', color: colors.teal, fontSize: '13px', fontWeight: '600' }}>{editSuccess}</div>
                    )}

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Display Name *</label>
                      <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={styles.input} autoComplete="off" />
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Username</label>
                      <input type="text" value={editHandle} onChange={(e) => setEditHandle(e.target.value)} style={styles.input} autoComplete="off" />
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Email *</label>
                      <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} style={styles.input} autoComplete="off" />
                    </div>

                    <div style={{ borderTop: `1px solid ${colors.creamDark}`, marginTop: '16px', paddingTop: '16px' }}>
                      <p style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '12px' }}>Security</p>

                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Current Password *</label>
                        <div style={pwFieldStyle}>
                          <input type={showCurrentPw ? 'text' : 'password'} value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder="Required to save changes" style={{ ...styles.input, paddingRight: '40px' }} autoComplete="off" />
                          <button type="button" onClick={() => setShowCurrentPw(!showCurrentPw)} style={eyeBtnStyle}><EyeSvg show={showCurrentPw} /></button>
                        </div>
                      </div>
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>New Password <span style={{ fontWeight: 'normal', color: '#6b7280' }}>(optional)</span></label>
                        <div style={pwFieldStyle}>
                          <input type={showNewPw ? 'text' : 'password'} value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="Min 8 characters" style={{ ...styles.input, paddingRight: '40px' }} autoComplete="off" />
                          <button type="button" onClick={() => setShowNewPw(!showNewPw)} style={eyeBtnStyle}><EyeSvg show={showNewPw} /></button>
                        </div>
                      </div>
                      {newPw && (
                        <div style={{ marginBottom: '12px' }}>
                          <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Confirm New Password</label>
                          <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="Re-enter new password" style={styles.input} autoComplete="off" />
                          {confirmPw && newPw !== confirmPw && (
                            <p style={{ fontSize: '11px', color: colors.red, margin: '4px 0 0' }}>Passwords do not match</p>
                          )}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={(e) => { confirmClick(e); handleSaveProfile(); }}
                      disabled={editLoading}
                      style={{ ...styles.gradientButton, marginTop: '8px', opacity: editLoading ? 0.7 : 1, position: 'relative', overflow: 'hidden' }}
                    >
                      {editLoading ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                );
              };
              return <EditProfileForm />;
            })()}
            {profileScreen === 'safety' && (
              <div>
                {/* Safety toggle */}
                <div style={styles.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>Safety Features</p>
                      <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>Quick exit & check-ins</p>
                    </div>
                    <Toggle on={safetyOn} onChange={() => setSafetyOn(!safetyOn)} />
                  </div>
                </div>

                {/* Info card */}
                <div style={{ ...styles.card, display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.shield(colors.red, 18)}</div>
                  <div>
                    <p style={{ fontWeight: '700', fontSize: '13px', color: colors.navy, margin: '0 0 4px' }}>Emergency Contacts</p>
                    <p style={{ fontSize: '11px', color: '#6b7280', margin: 0, lineHeight: '1.4' }}>Add trusted contacts who will receive alerts when you use the emergency button. They'll get a message with your location.</p>
                  </div>
                </div>

                {/* Trusted contacts list */}
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 12px' }}>Trusted Contacts ({trustedContacts.length})</h3>

                  {safetyLoading && trustedContacts.length === 0 && (
                    <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', padding: '16px 0' }}>Loading...</p>
                  )}

                  {!safetyLoading && trustedContacts.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px 0' }}>
                      <div style={{ fontSize: '36px', marginBottom: '8px' }}>{'👤'}</div>
                      <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>No trusted contacts yet</p>
                    </div>
                  )}

                  {trustedContacts.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                      <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '16px', color: colors.navy, flexShrink: 0 }}>{c.contact_name?.[0]?.toUpperCase() || '?'}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: '600', fontSize: '14px', color: colors.navy, margin: 0 }}>{c.contact_name}</p>
                        <p style={{ fontSize: '12px', color: '#6b7280', margin: '2px 0 0' }}>{c.contact_phone}</p>
                        {c.contact_email && <p style={{ fontSize: '11px', color: '#9ca3af', margin: '1px 0 0' }}>{c.contact_email}</p>}
                        {c.relationship && <span style={{ display: 'inline-block', marginTop: '3px', padding: '1px 8px', background: colors.cream, borderRadius: '10px', fontSize: '10px', color: '#6b7280', textTransform: 'capitalize' }}>{c.relationship}</span>}
                      </div>
                      <button onClick={() => handleEditContact(c)} style={{ background: 'none', border: 'none', color: colors.navy, fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Edit</button>
                      <button onClick={() => handleDeleteContact(c.id)} style={{ background: 'none', border: 'none', color: colors.red, fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Remove</button>
                    </div>
                  ))}

                  {/* Add contact button */}
                  <button onClick={() => setShowAddContact(true)} style={{ width: '100%', padding: '12px', borderRadius: '10px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: colors.navy, fontWeight: '600', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '12px' }}>
                    {Icons.plus(colors.navy, 14)} Add Trusted Contact
                  </button>
                </div>

                {/* Add Contact Modal */}
                {showAddContact && (
                  <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 1000 }}>
                    <div style={{ background: 'white', width: '100%', borderRadius: '20px 20px 0 0', padding: '20px', maxHeight: '80vh', overflowY: 'auto' }}>
                      <h3 style={{ fontWeight: '800', fontSize: '18px', color: colors.navy, margin: '0 0 16px' }}>{editingContact ? 'Edit Contact' : 'Add Trusted Contact'}</h3>

                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Name *</label>
                        <input type="text" value={newContact.name} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} placeholder="Contact name" style={{ ...styles.input, width: '100%' }} autoComplete="off" />
                      </div>

                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Phone Number *</label>
                        <input type="tel" value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} placeholder="+1 234 567 8900" style={{ ...styles.input, width: '100%' }} autoComplete="off" />
                      </div>

                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Email * <span style={{ fontWeight: '400', color: '#9ca3af' }}>(alerts sent here)</span></label>
                        <input type="email" value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} placeholder="email@example.com" style={{ ...styles.input, width: '100%' }} autoComplete="off" />
                      </div>

                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Relationship (optional)</label>
                        <select value={newContact.relationship} onChange={(e) => setNewContact({ ...newContact, relationship: e.target.value })} style={{ ...styles.input, width: '100%', appearance: 'auto' }}>
                          <option value="">Select...</option>
                          <option value="parent">Parent</option>
                          <option value="sibling">Sibling</option>
                          <option value="partner">Partner</option>
                          <option value="friend">Friend</option>
                          <option value="roommate">Roommate</option>
                          <option value="other">Other</option>
                        </select>
                      </div>

                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => { setShowAddContact(false); setEditingContact(null); setNewContact({ name: '', phone: '', email: '', relationship: '' }); }} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', fontSize: '14px', cursor: 'pointer', color: colors.navy }}>Cancel</button>
                        <button disabled={safetyLoading} onClick={handleSaveContact} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', fontSize: '14px', cursor: 'pointer', opacity: safetyLoading ? 0.6 : 1 }}>{safetyLoading ? 'Saving...' : editingContact ? 'Save Changes' : 'Add Contact'}</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {profileScreen === 'interests' && (
              <div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 12px' }}>Your Interests</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                    {userInterests.map(interest => (
                      <div key={interest} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '20px', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '12px', fontWeight: '600' }}>
                        {interest}
                        <button onClick={(e) => { confirmClick(e); setUserInterests(userInterests.filter(i => i !== interest)); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: 0, display: 'flex', position: 'relative', overflow: 'hidden' }}>{Icons.x('rgba(255,255,255,0.7)', 14)}</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input type="text" value={newInterest} onChange={(e) => setNewInterest(e.target.value)} placeholder="Add an interest..." style={{ ...styles.input, flex: 1 }} autoComplete="off" />
                    <button onClick={(e) => { if (newInterest.trim() && !userInterests.includes(newInterest.trim())) { confirmClick(e); setUserInterests([...userInterests, newInterest.trim()]); setNewInterest(''); }}} style={{ padding: '0 16px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                  </div>
                </div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 12px' }}>Suggested Interests</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {suggestedInterests.filter(s => !userInterests.includes(s)).map(interest => (
                      <button key={interest} onClick={(e) => { confirmClick(e); setUserInterests([...userInterests, interest]); }} style={{ padding: '6px 12px', borderRadius: '20px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontSize: '12px', fontWeight: '500', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', position: 'relative', overflow: 'hidden' }}>
                        {Icons.plus(colors.navy, 12)} {interest}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {profileScreen === 'payment' && (
              <div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 12px' }}>Saved Cards</h3>
                  {paymentMethods.length === 0 ? (
                    <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', padding: '16px 0' }}>No payment methods saved</p>
                  ) : (
                    paymentMethods.map(card => (
                      <div key={card.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '12px', backgroundColor: colors.cream, marginBottom: '8px' }}>
                        <div style={{ width: '44px', height: '28px', borderRadius: '4px', background: card.brand === 'Visa' ? 'linear-gradient(135deg, #1A1F71, #2E3691)' : 'linear-gradient(135deg, #EB001B, #F79E1B)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '10px', fontWeight: 'bold' }}>
                          {card.brand}
                        </div>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: '14px', fontWeight: '600', color: colors.navy, margin: 0 }}>•••• {card.last4}</p>
                          <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Expires {card.expiry}</p>
                        </div>
                        {card.isDefault && <span style={{ fontSize: '9px', fontWeight: '600', color: '#22C55E', backgroundColor: '#DCFCE7', padding: '2px 6px', borderRadius: '4px' }}>Default</span>}
                        <button onClick={(e) => { confirmClick(e); setPaymentMethods(paymentMethods.filter(c => c.id !== card.id)); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', position: 'relative', overflow: 'hidden' }}>{Icons.x('#9ca3af', 16)}</button>
                      </div>
                    ))
                  )}
                  {!showAddCard ? (
                    <button onClick={() => setShowAddCard(true)} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: colors.navy, fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
                      {Icons.plus(colors.navy, 16)} Add New Card
                    </button>
                  ) : (
                    <div style={{ marginTop: '12px', padding: '16px', borderRadius: '12px', backgroundColor: colors.cream }}>
                      <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: '0 0 12px' }}>Add New Card</h4>
                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Card Number</label>
                        <input type="text" value={newCard.number} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 16); const formatted = v.replace(/(\d{4})/g, '$1 ').trim(); setNewCard({ ...newCard, number: formatted }); }} placeholder="1234 5678 9012 3456" style={{ ...styles.input, letterSpacing: '1px' }} autoComplete="off" />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Expiry</label>
                          <input type="text" value={newCard.expiry} onChange={(e) => { let v = e.target.value.replace(/\D/g, '').slice(0, 4); if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2); setNewCard({ ...newCard, expiry: v }); }} placeholder="MM/YY" style={styles.input} autoComplete="off" />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>CVV</label>
                          <input type="text" value={newCard.cvv} onChange={(e) => setNewCard({ ...newCard, cvv: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="123" style={styles.input} autoComplete="off" />
                        </div>
                      </div>
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Cardholder Name</label>
                        <input type="text" value={newCard.name} onChange={(e) => setNewCard({ ...newCard, name: e.target.value })} placeholder="John Doe" style={styles.input} autoComplete="off" />
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => { setShowAddCard(false); setNewCard({ number: '', expiry: '', cvv: '', name: '' }); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                        <button onClick={(e) => { if (newCard.number.length >= 19 && newCard.expiry.length === 5 && newCard.cvv.length === 3 && newCard.name.trim()) { confirmClick(e); const brand = newCard.number.startsWith('4') ? 'Visa' : 'MC'; setPaymentMethods([...paymentMethods, { id: Date.now(), brand, last4: newCard.number.slice(-4), expiry: newCard.expiry, isDefault: paymentMethods.length === 0 }]); setNewCard({ number: '', expiry: '', cvv: '', name: '' }); setShowAddCard(false); } else { showToast('Please fill all fields', 'error'); }}} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add Card</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {profileScreen !== 'edit' && (
            <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
              <button onClick={(e) => { confirmClick(e); setProfileScreen('main'); }} style={{ ...styles.gradientButton, position: 'relative', overflow: 'hidden' }}>Save</button>
            </div>
          )}
        </div>
      );
    }

    return (
      <div key="profile-main-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        <div style={{ padding: '20px', textAlign: 'center', background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`, flexShrink: 0 }}>
          <button onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', margin: '0 auto 8px', backgroundColor: 'rgba(255,255,255,0.2)', border: '4px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: 'pointer' }}>
            {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user(colors.navy, 32)}
          </button>
          <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0 }}>{profileName}</h1>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>@{profileHandle}</p>
          <div style={{ marginTop: '12px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '12px', padding: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '10px' }}>Level {userLevel}</span>
              <span style={{ color: 'white', fontWeight: 'bold', fontSize: '12px' }}>{userXP} XP</span>
            </div>
            <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${userXP % 100}%`, backgroundColor: colors.amber, borderRadius: '3px', transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', boxShadow: '0 0 10px rgba(245,158,11,0.5)' }} />
            </div>
          </div>
        </div>

        <div style={{ flex: 1, padding: '12px', overflowY: 'auto', marginTop: '-8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
            {[{ l: 'Flocks', v: flocks.length }, { l: 'Friends', v: flockFriends.length }, { l: 'Streak', v: streak, hasIcon: true }, { l: 'Events', v: calendarEvents.length }].map(s => (
              <div key={s.l} style={{ backgroundColor: 'white', borderRadius: '12px', padding: '8px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <p style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{s.v}{s.hasIcon && Icons.flame('#F59E0B', 16)}</p>
                <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>{s.l}</p>
              </div>
            ))}
          </div>

          {/* Add Friends Button */}
          <button onClick={() => setCurrentScreen('addFriends')} style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', boxShadow: '0 4px 12px rgba(13,40,71,0.25)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.userPlus('white', 18)}</div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <span style={{ fontWeight: '700', fontSize: '15px', display: 'block' }}>Add Friends</span>
              <span style={{ fontSize: '11px', opacity: 0.7 }}>Find people, scan QR, sync contacts</span>
            </div>
            {pendingRequests.length > 0 && <span style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: colors.amber, fontSize: '12px', fontWeight: '700' }}>{pendingRequests.length}</span>}
            <span style={{ opacity: 0.6 }}>›</span>
          </button>

          <div style={{ backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            {[
              { l: 'Edit Profile', s: 'edit', icon: Icons.edit },
              { l: 'Interests', s: 'interests', icon: Icons.target },
              { l: 'Safety', s: 'safety', icon: Icons.shield },
              { l: 'Payment', s: 'payment', icon: Icons.creditCard },
            ].map(m => (
              <button key={m.s} onClick={() => { setProfileScreen(m.s); if (m.s === 'safety') loadTrustedContacts(); }} style={{ width: '100%', padding: '12px', textAlign: 'left', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'white', border: 'none', cursor: 'pointer' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{m.icon(colors.navy, 18)}</div>
                <span style={{ flex: 1, fontWeight: '600', fontSize: '14px', color: colors.navy }}>{m.l}</span>
                <span style={{ color: '#9ca3af' }}>›</span>
              </button>
            ))}
            <button onClick={() => { if (onLogout) onLogout(); }} style={{ width: '100%', padding: '12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'white', border: 'none', cursor: 'pointer', color: colors.red }}>
              {Icons.logout(colors.red, 18)}
              <span style={{ fontWeight: '600', fontSize: '14px' }}>Log Out</span>
            </button>
          </div>

          {/* Admin Access Button - Small and subtle at bottom */}
          <button
            onClick={() => setShowAdminPrompt(true)}
            style={{
              marginTop: '16px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: `1px dashed ${colors.creamDark}`,
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              justifyContent: 'center'
            }}
          >
            {Icons.settings('#9ca3af', 12)} Admin
          </button>

          {/* Venue Owner Access Button */}
          <button
            onClick={() => setCurrentScreen('venueDashboard')}
            style={{
              marginTop: '8px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: `1px dashed ${colors.creamDark}`,
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              justifyContent: 'center'
            }}
          >
            {Icons.home('#9ca3af', 12)} Venue Dashboard
          </button>

          {/* Switch Mode Button */}
          {userMode && (
            <button
              onClick={switchMode}
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #EF4444',
                backgroundColor: 'rgba(239,68,68,0.1)',
                color: '#EF4444',
                fontSize: '10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              {Icons.repeat('#EF4444', 12)} Switch Mode (Current: {userMode === 'user' ? 'User' : userMode === 'venue' ? 'Venue' : 'Admin'})
            </button>
          )}

          {/* Replay Onboarding Button */}
          {userMode === 'user' && (
            <button
              onClick={() => {
                localStorage.removeItem('flockOnboardingComplete');
                setHasCompletedOnboarding(false);
                setOnboardingStep(0);
                setOnboardingVibes([]);
              }}
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: `1px solid ${colors.teal}`,
                backgroundColor: 'rgba(20,184,166,0.1)',
                color: colors.teal,
                fontSize: '10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              {Icons.repeat(colors.teal, 12)} Replay Onboarding
            </button>
          )}

          {/* Legal Links */}
          <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: `1px solid ${colors.creamDark}` }}>
            <p style={{ fontSize: '10px', color: '#9ca3af', marginBottom: '12px', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Legal</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button
                onClick={() => window.open('https://flock.app/terms', '_blank')}
                style={{
                  padding: '10px 16px',
                  borderRadius: '10px',
                  border: `1px solid ${colors.creamDark}`,
                  backgroundColor: 'white',
                  color: colors.navy,
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {Icons.fileText(colors.navy, 14)} Terms of Service
              </button>
              <button
                onClick={() => window.open('https://flock.app/privacy', '_blank')}
                style={{
                  padding: '10px 16px',
                  borderRadius: '10px',
                  border: `1px solid ${colors.creamDark}`,
                  backgroundColor: 'white',
                  color: colors.navy,
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {Icons.shield(colors.navy, 14)} Privacy Policy
              </button>
            </div>
            <p style={{ fontSize: '10px', color: '#9ca3af', marginTop: '16px', textAlign: 'center' }}>Flock v1.0.0</p>
          </div>

        </div>

        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // VENUE DASHBOARD SCREEN (For Venue Owners)
  const VenueDashboard = () => {
    // venueTab state is now at App level to persist across re-renders
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);

    // Promotion state
    const [promotions, setPromotions] = useState([
      { id: 1, title: 'Happy Hour Special', desc: '50% off drinks', time: '5-7 PM', days: 'Mon-Fri', views: 234, claims: 89 },
      { id: 2, title: 'Late Night Bites', desc: '$5 appetizers', time: '10PM-Close', days: 'Daily', views: 156, claims: 45 }
    ]);
    const [showPromoModal, setShowPromoModal] = useState(false);
    const [editingPromo, setEditingPromo] = useState(null);
    const [promoForm, setPromoForm] = useState({ title: '', desc: '', time: 'Happy Hour', days: 'Daily' });

    // Event state
    const [venueEventsList, setVenueEventsList] = useState([
      { id: 1, title: 'Live Jazz Night', date: 'Jan 24', time: '9:00 PM', rsvps: 45, capacity: 60 },
      { id: 2, title: 'Trivia Tuesday', date: 'Jan 21', time: '7:00 PM', rsvps: 28, capacity: 40 }
    ]);
    const [showEventModal, setShowEventModal] = useState(false);
    const [editingEvent, setEditingEvent] = useState(null);
    const [eventForm, setEventForm] = useState({ title: '', date: '', time: '', capacity: '' });

    // Incoming flocks
    const incomingFlocks = [
      { id: 1, name: "Alex's Birthday Party", time: 'Saturday 8 PM', members: 12, status: 'confirmed' },
      { id: 2, name: 'Friday Night Out', time: 'Friday 10 PM', members: 6, status: 'pending' }
    ];

    // Reviews (read-only)
    const reviews = [
      { id: 1, user: 'Sarah M.', rating: 5, text: 'Great atmosphere and amazing cocktails!', date: '2 days ago', replied: true },
      { id: 2, user: 'Mike J.', rating: 4, text: 'Good drinks, bit crowded on weekends.', date: '1 week ago', replied: false },
      { id: 3, user: 'Emma L.', rating: 5, text: 'Perfect spot for our flock meetup! Staff was super friendly.', date: '2 weeks ago', replied: true }
    ];

    // Settings state
    const [venueInfo, setVenueInfo] = useState({ name: 'The Blue Heron Bar', address: '123 Main St, Easton PA', phone: '(610) 555-0123' });
    const [editingVenueInfo, setEditingVenueInfo] = useState(false);
    const [operatingHours, setOperatingHours] = useState([
      { days: 'Mon-Thu', open: '4:00 PM', close: '12:00 AM' },
      { days: 'Fri-Sat', open: '4:00 PM', close: '2:00 AM' },
      { days: 'Sunday', open: '12:00 PM', close: '10:00 PM' }
    ]);
    const [showHoursModal, setShowHoursModal] = useState(false);
    const [notifications, setNotifications] = useState({ bookings: true, reviews: true, weekly: false });

    // Deal posting state (for quick deals on analytics tab)
    const [dealDescription, setDealDescription] = useState('');
    const [dealTimeSlot, setDealTimeSlot] = useState('Happy Hour');

    const venueTabs = [
      { id: 'analytics', label: 'Analytics', icon: Icons.barChart },
      { id: 'promotions', label: 'Promotions', icon: Icons.gift },
      { id: 'events', label: 'Events', icon: Icons.calendar },
      { id: 'reviews', label: 'Reviews', icon: Icons.star },
      { id: 'settings', label: 'Settings', icon: Icons.settings }
    ];

    // Promotion handlers
    const openPromoModal = (promo = null) => {
      if (promo) {
        setEditingPromo(promo);
        setPromoForm({ title: promo.title, desc: promo.desc, time: promo.time, days: promo.days });
      } else {
        setEditingPromo(null);
        setPromoForm({ title: '', desc: '', time: 'Happy Hour', days: 'Daily' });
      }
      setShowPromoModal(true);
    };

    const savePromo = () => {
      if (!promoForm.title.trim()) return;
      if (editingPromo) {
        setPromotions(prev => prev.map(p => p.id === editingPromo.id ? { ...p, ...promoForm } : p));
             } else {
        setPromotions(prev => [...prev, { id: Date.now(), ...promoForm, views: 0, claims: 0 }]);
             }
      setShowPromoModal(false);
    };

    const deletePromo = (id) => {
      setPromotions(prev => prev.filter(p => p.id !== id));
         };

    // Event handlers
    const openEventModal = (event = null) => {
      if (event) {
        setEditingEvent(event);
        setEventForm({ title: event.title, date: event.date, time: event.time, capacity: event.capacity.toString() });
      } else {
        setEditingEvent(null);
        setEventForm({ title: '', date: '', time: '', capacity: '' });
      }
      setShowEventModal(true);
    };

    const saveEvent = () => {
      if (!eventForm.title.trim()) return;
      if (editingEvent) {
        setVenueEventsList(prev => prev.map(e => e.id === editingEvent.id ? { ...e, ...eventForm, capacity: parseInt(eventForm.capacity) || 50 } : e));
             } else {
        setVenueEventsList(prev => [...prev, { id: Date.now(), ...eventForm, capacity: parseInt(eventForm.capacity) || 50, rsvps: 0 }]);
             }
      setShowEventModal(false);
    };

    const deleteEvent = (id) => {
      setVenueEventsList(prev => prev.filter(e => e.id !== id));
         };

    // Mock venue data
    const venueData = {
      name: "The Blue Heron Bar",
      logo: null,
      tier: venueTier,
      todayCheckins: 47,
      weekTraffic: 312,
      crowdForecast: 78,
      peakHours: [
        { hour: '6pm', value: 30 },
        { hour: '7pm', value: 45 },
        { hour: '8pm', value: 65 },
        { hour: '9pm', value: 85 },
        { hour: '10pm', value: 95 },
        { hour: '11pm', value: 80 },
        { hour: '12am', value: 55 },
      ],
      topInterests: ['Live Music', 'Cocktails', 'Sports'],
      repeatRate: 34,
      demographics: { '21-25': 35, '26-30': 40, '31-35': 15, '36+': 10 },
    };

    const tierBadge = {
      free: { label: 'Free', color: '#6b7280', bg: '#f3f4f6' },
      premium: { label: 'Premium', color: '#b45309', bg: '#fef3c7' },
      pro: { label: 'Pro', color: '#7c3aed', bg: '#ede9fe' },
    };

    const features = {
      free: ['Basic listing', 'Venue info', 'User reviews'],
      premium: ['Enhanced visibility', 'Post deals', 'Event promotion', 'Basic analytics'],
      pro: ['Everything in Premium', 'Detailed insights', 'Push notifications', 'AI recommendations'],
    };

    const isFeatureLocked = (feature) => {
      if (venueTier === 'pro') return false;
      if (venueTier === 'premium' && ['Post deals', 'Event promotion', 'Basic analytics', 'Enhanced visibility'].includes(feature)) return false;
      if (['Basic listing', 'Venue info', 'User reviews'].includes(feature)) return false;
      return true;
    };

    return (
      <div key="venue-dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button onClick={switchMode} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            <span style={{ ...tierBadge[venueData.tier], padding: '4px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: '700', backgroundColor: tierBadge[venueData.tier].bg, color: tierBadge[venueData.tier].color }}>
              {tierBadge[venueData.tier].label}
            </span>
          </div>
          <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.home('white', 24)}
            </div>
            <div>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>Welcome, {venueData.name}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Venue Dashboard</p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
          {venueTabs.map(tab => (
            <button key={tab.id} onClick={() => setVenueTab(tab.id)} style={{ flex: 1, padding: '10px 4px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', borderBottom: venueTab === tab.id ? `2px solid ${colors.navy}` : '2px solid transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
              {tab.icon(venueTab === tab.id ? colors.navy : '#9ca3af', 16)}
              <span style={{ fontSize: '9px', fontWeight: venueTab === tab.id ? '700' : '500', color: venueTab === tab.id ? colors.navy : '#9ca3af' }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* ANALYTICS TAB */}
          {venueTab === 'analytics' && (<>
          {/* Key Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '12px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Today's Check-ins</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.todayCheckins}</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>This Week</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.weekTraffic}</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Crowd Forecast</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: venueData.crowdForecast > 70 ? colors.red : colors.teal, margin: '4px 0 0' }}>{venueData.crowdForecast}%</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Repeat Rate</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.repeatRate}%</p>
              {isFeatureLocked('Detailed insights') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 20)}</div>}
            </div>
          </div>

          {/* Demographics */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Customer Demographics</h3>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '60px' }}>
              {Object.entries(venueData.demographics).map(([age, pct]) => (
                <div key={age} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', height: `${pct * 0.6}px`, backgroundColor: colors.navy, borderRadius: '4px 4px 0 0' }} />
                  <span style={{ fontSize: '8px', color: '#6b7280', marginTop: '4px' }}>{age}</span>
                  <span style={{ fontSize: '9px', fontWeight: '600', color: colors.navy }}>{pct}%</span>
                </div>
              ))}
            </div>
            {isFeatureLocked('Detailed insights') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Pro Feature</span></div>}
          </div>

          {/* Post a Deal */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.zap(colors.amber, 14)} Post a Deal</h3>
            <input
              type="text"
              value={dealDescription}
              onChange={(e) => setDealDescription(e.target.value)}
              placeholder="e.g., 2-for-1 drinks until 8pm"
              style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '12px', marginBottom: '8px', boxSizing: 'border-box' }}
              disabled={isFeatureLocked('Post deals')}
            />
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              {['Happy Hour', 'Late Night', 'Weekend', 'All Day'].map(slot => (
                <button key={slot} onClick={() => setDealTimeSlot(slot)} style={{ padding: '6px 10px', borderRadius: '16px', border: `1px solid ${dealTimeSlot === slot ? colors.navy : colors.creamDark}`, backgroundColor: dealTimeSlot === slot ? colors.navy : 'white', color: dealTimeSlot === slot ? 'white' : colors.navy, fontSize: '10px', fontWeight: '500', cursor: 'pointer' }} disabled={isFeatureLocked('Post deals')}>
                  {slot}
                </button>
              ))}
            </div>
            <button onClick={() => { setDealDescription(''); }} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer' }} disabled={isFeatureLocked('Post deals') || !dealDescription.trim()}>
              Post Deal
            </button>
            {isFeatureLocked('Post deals') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Premium Feature</span></div>}
          </div>

          {/* Peak Hours */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Peak Hours (Tonight)</h3>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '50px' }}>
              {venueData.peakHours.map((h, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', height: `${h.value * 0.5}px`, backgroundColor: h.value > 80 ? colors.red : h.value > 50 ? colors.amber : colors.teal, borderRadius: '2px', transition: 'all 0.3s' }} />
                  <span style={{ fontSize: '8px', color: '#6b7280', marginTop: '4px' }}>{h.hour}</span>
                </div>
              ))}
            </div>
            {isFeatureLocked('Basic analytics') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Premium Feature</span></div>}
          </div>

          {/* Top Interests */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Top Visitor Interests</h3>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {venueData.topInterests.map(interest => (
                <span key={interest} style={{ padding: '6px 12px', borderRadius: '16px', backgroundColor: colors.cream, fontSize: '11px', fontWeight: '500', color: colors.navy }}>
                  {interest}
                </span>
              ))}
            </div>
          </div>

          {/* Upgrade Button (if not Pro) */}
          {venueTier !== 'pro' && (
            <button onClick={() => setShowUpgradeModal(true)} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: 'linear-gradient(135deg, #7c3aed, #a78bfa)', color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', boxShadow: '0 4px 12px rgba(124,58,237,0.3)' }}>
              {Icons.sparkles('white', 18)} Upgrade to {venueTier === 'free' ? 'Premium' : 'Pro'}
            </button>
          )}
          </>)}

          {/* PROMOTIONS TAB */}
          {venueTab === 'promotions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Create New Promotion Button */}
              <button onClick={() => openPromoModal()} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.plus('white', 18)} Create Promotion
              </button>

              {/* Active Promotions */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Active Promotions ({promotions.length})</h3>
                {promotions.length === 0 ? (
                  <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '20px' }}>No promotions yet. Create your first one!</p>
                ) : promotions.map(promo => (
                  <div key={promo.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{promo.title}</h4>
                        <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0' }}>{promo.desc}</p>
                        <p style={{ fontSize: '10px', color: '#9ca3af', margin: 0 }}>{promo.time} - {promo.days}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => openPromoModal(promo)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.edit(colors.navy, 14)}</button>
                        <button onClick={() => deletePromo(promo.id)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.trash(colors.red, 14)}</button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {Icons.eye('#6b7280', 12)}
                        <span style={{ fontSize: '10px', color: '#6b7280' }}>{promo.views} views</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {Icons.checkCircle(colors.teal, 12)}
                        <span style={{ fontSize: '10px', color: '#6b7280' }}>{promo.claims} claims</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Promotion Tips */}
              <div style={{ backgroundColor: colors.cream, borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '11px', fontWeight: '700', color: colors.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.sparkles(colors.amber, 12)} Pro Tips</h4>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '10px', color: '#6b7280' }}>
                  <li>Happy Hour promos get 3x more engagement</li>
                  <li>Add specific discounts for better conversion</li>
                  <li>Weekend promos should be posted by Thursday</li>
                </ul>
              </div>
            </div>
          )}

          {/* EVENTS TAB */}
          {venueTab === 'events' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Create Event Button */}
              <button onClick={() => openEventModal()} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.plus('white', 18)} Create Event
              </button>

              {/* Incoming Flocks */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.users(colors.teal, 14)} Incoming Flocks</h3>
                {incomingFlocks.length > 0 ? incomingFlocks.map(flock => (
                  <div key={flock.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{flock.name}</h4>
                        <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0' }}>{flock.members} members - {flock.time}</p>
                      </div>
                      <span style={{ padding: '4px 8px', borderRadius: '12px', backgroundColor: flock.status === 'confirmed' ? colors.teal : colors.amber, color: 'white', fontSize: '9px', fontWeight: '600' }}>
                        {flock.status === 'confirmed' ? 'Confirmed' : 'Pending'}
                      </span>
                    </div>
                  </div>
                )) : <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '20px' }}>No incoming flocks scheduled</p>}
              </div>

              {/* Your Events */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.calendar(colors.navy, 14)} Your Events ({venueEventsList.length})</h3>
                {venueEventsList.length === 0 ? (
                  <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '20px' }}>No events yet. Create your first one!</p>
                ) : venueEventsList.map(event => (
                  <div key={event.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{event.title}</h4>
                        <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0' }}>{event.date} at {event.time}</p>
                        <p style={{ fontSize: '10px', color: '#9ca3af', margin: 0 }}>{event.rsvps}/{event.capacity} RSVPs</p>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => openEventModal(event)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.edit(colors.navy, 14)}</button>
                        <button onClick={() => deleteEvent(event.id)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.trash(colors.red, 14)}</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Event Calendar Preview */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>This Week</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', textAlign: 'center' }}>
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                    <div key={i} style={{ fontSize: '9px', fontWeight: '600', color: '#9ca3af', padding: '4px' }}>{d}</div>
                  ))}
                  {[19, 20, 21, 22, 23, 24, 25].map((day, i) => (
                    <div key={day} style={{ padding: '8px 4px', borderRadius: '6px', backgroundColor: i === 5 || i === 6 ? colors.navy : 'transparent', color: i === 5 || i === 6 ? 'white' : colors.navy, fontSize: '11px', fontWeight: '600' }}>
                      {day}
                      {(i === 5 || i === 6) && <div style={{ width: '4px', height: '4px', borderRadius: '2px', backgroundColor: colors.amber, margin: '2px auto 0' }} />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* REVIEWS TAB */}
          {venueTab === 'reviews' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Rating Overview */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ fontSize: '32px', fontWeight: '900', color: colors.navy, margin: 0 }}>4.7</p>
                    <div style={{ display: 'flex', gap: '2px', justifyContent: 'center', margin: '4px 0' }}>
                      {[1, 2, 3, 4, 5].map(s => s <= 4 ? Icons.starFilled(colors.amber, 14) : Icons.star(colors.amber, 14))}
                    </div>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>156 reviews</p>
                  </div>
                  <div style={{ flex: 1 }}>
                    {[5, 4, 3, 2, 1].map(rating => (
                      <div key={rating} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '10px', color: '#6b7280', width: '12px' }}>{rating}</span>
                        <div style={{ flex: 1, height: '6px', backgroundColor: colors.cream, borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${rating === 5 ? 60 : rating === 4 ? 25 : rating === 3 ? 10 : rating === 2 ? 3 : 2}%`, backgroundColor: colors.amber, borderRadius: '3px' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Recent Reviews */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Recent Reviews</h3>
                {reviews.map(review => (
                  <div key={review.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '12px', fontWeight: '700' }}>
                          {review.user.charAt(0)}
                        </div>
                        <div>
                          <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{review.user}</p>
                          <div style={{ display: 'flex', gap: '1px' }}>
                            {[1, 2, 3, 4, 5].map(s => s <= review.rating ? Icons.starFilled(colors.amber, 10) : Icons.star('#d1d5db', 10))}
                          </div>
                        </div>
                      </div>
                      <span style={{ fontSize: '9px', color: '#9ca3af' }}>{review.date}</span>
                    </div>
                    <p style={{ fontSize: '11px', color: '#4b5563', margin: '8px 0 0', lineHeight: '1.4' }}>{review.text}</p>
                    {!review.replied && (
                      <button onClick={() => {}} style={{ marginTop: '8px', padding: '6px 10px', borderRadius: '6px', border: `1px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontSize: '10px', fontWeight: '500', cursor: 'pointer' }}>
                        Reply
                      </button>
                    )}
                    {review.replied && <p style={{ fontSize: '10px', color: colors.teal, margin: '8px 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.checkCircle(colors.teal, 12)} Replied</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETTINGS TAB */}
          {venueTab === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Venue Info */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.building(colors.navy, 14)} Venue Information</h3>
                  {!editingVenueInfo ? (
                    <button onClick={() => setEditingVenueInfo(true)} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: colors.cream, color: colors.navy, fontSize: '10px', fontWeight: '500', cursor: 'pointer' }}>Edit</button>
                  ) : (
                    <button onClick={() => { setEditingVenueInfo(false); }} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: colors.teal, color: 'white', fontSize: '10px', fontWeight: '500', cursor: 'pointer' }}>Save</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div>
                    <label style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Venue Name</label>
                    <input type="text" value={venueInfo.name} onChange={(e) => setVenueInfo({...venueInfo, name: e.target.value})} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: '12px', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'white' : colors.cream }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Address</label>
                    <input type="text" value={venueInfo.address} onChange={(e) => setVenueInfo({...venueInfo, address: e.target.value})} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: '12px', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'white' : colors.cream }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Phone</label>
                    <input type="text" value={venueInfo.phone} onChange={(e) => setVenueInfo({...venueInfo, phone: e.target.value})} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: '12px', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'white' : colors.cream }} />
                  </div>
                </div>
              </div>

              {/* Operating Hours */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.clock(colors.navy, 14)} Operating Hours</h3>
                {operatingHours.map((slot, i) => (
                  <div key={slot.days} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < operatingHours.length - 1 ? `1px solid ${colors.cream}` : 'none' }}>
                    <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy }}>{slot.days}</span>
                    <span style={{ fontSize: '11px', color: '#6b7280' }}>{slot.open} - {slot.close}</span>
                  </div>
                ))}
                <button onClick={() => setShowHoursModal(true)} style={{ marginTop: '8px', width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontSize: '11px', fontWeight: '500', cursor: 'pointer' }}>
                  Edit Hours
                </button>
              </div>

              {/* Notification Settings */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.bell(colors.navy, 14)} Notifications</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                  <div>
                    <p style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, margin: 0 }}>New bookings</p>
                    <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>Get notified when a flock books</p>
                  </div>
                  <div onClick={() => { setNotifications({...notifications, bookings: !notifications.bookings}); }} style={{ width: '36px', height: '20px', borderRadius: '10px', backgroundColor: notifications.bookings ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: '2px', left: notifications.bookings ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '8px', backgroundColor: 'white', transition: 'left 0.2s' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                  <div>
                    <p style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, margin: 0 }}>New reviews</p>
                    <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>Alerts for customer reviews</p>
                  </div>
                  <div onClick={() => { setNotifications({...notifications, reviews: !notifications.reviews}); }} style={{ width: '36px', height: '20px', borderRadius: '10px', backgroundColor: notifications.reviews ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: '2px', left: notifications.reviews ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '8px', backgroundColor: 'white', transition: 'left 0.2s' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
                  <div>
                    <p style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, margin: 0 }}>Weekly reports</p>
                    <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>Performance summary emails</p>
                  </div>
                  <div onClick={() => { setNotifications({...notifications, weekly: !notifications.weekly}); }} style={{ width: '36px', height: '20px', borderRadius: '10px', backgroundColor: notifications.weekly ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: '2px', left: notifications.weekly ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '8px', backgroundColor: 'white', transition: 'left 0.2s' }} />
                  </div>
                </div>
              </div>

              {/* Subscription */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.creditCard(colors.navy, 14)} Subscription</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                  <div>
                    <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>{tierBadge[venueData.tier].label} Plan</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{venueTier === 'free' ? 'Free forever' : venueTier === 'premium' ? '$35/month' : '$75/month'}</p>
                  </div>
                  {venueTier !== 'pro' && (
                    <button onClick={() => setShowUpgradeModal(true)} style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', background: 'linear-gradient(90deg, #7c3aed, #a78bfa)', color: 'white', fontSize: '10px', fontWeight: '600', cursor: 'pointer' }}>
                      Upgrade
                    </button>
                  )}
                </div>
              </div>

              {/* Danger Zone */}
              <div style={{ backgroundColor: '#fef2f2', borderRadius: '12px', padding: '12px', border: '1px solid #fecaca' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.red, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.alertCircle(colors.red, 14)} Danger Zone</h3>
                <button onClick={() => {}} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.red}`, backgroundColor: 'white', color: colors.red, fontSize: '11px', fontWeight: '500', cursor: 'pointer' }}>
                  Deactivate Venue Listing
                </button>
              </div>
            </div>
          )}

          {/* Upgrade Modal */}
          {showUpgradeModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Choose Your Plan</h2>

                {/* Free Tier */}
                <div style={{ border: `2px solid ${venueTier === 'free' ? colors.navy : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: colors.navy }}>Free</span>
                    <span style={{ fontWeight: '900', color: colors.navy }}>$0/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.free.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'free' && <span style={{ display: 'block', textAlign: 'center', fontSize: '10px', color: colors.teal, fontWeight: '600', marginTop: '8px' }}>Current Plan</span>}
                </div>

                {/* Premium Tier */}
                <div style={{ border: `2px solid ${venueTier === 'premium' ? '#b45309' : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px', backgroundColor: venueTier === 'premium' ? '#fffbeb' : 'white' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: '#b45309' }}>Premium</span>
                    <span style={{ fontWeight: '900', color: '#b45309' }}>$35/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.premium.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'premium' ? <span style={{ display: 'block', textAlign: 'center', fontSize: '10px', color: '#b45309', fontWeight: '600', marginTop: '8px' }}>Current Plan</span> : venueTier === 'free' && <button onClick={() => { setVenueTier('premium'); setShowUpgradeModal(false); }} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', backgroundColor: '#b45309', color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer', marginTop: '8px' }}>Upgrade</button>}
                </div>

                {/* Pro Tier */}
                <div style={{ border: '2px solid #7c3aed', borderRadius: '12px', padding: '12px', marginBottom: '16px', backgroundColor: '#faf5ff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: '#7c3aed' }}>Pro</span>
                    <span style={{ fontWeight: '900', color: '#7c3aed' }}>$75/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.pro.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  <button onClick={() => { setVenueTier('pro'); setShowUpgradeModal(false); }} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', background: 'linear-gradient(90deg, #7c3aed, #a78bfa)', color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer', marginTop: '8px' }}>Upgrade to Pro</button>
                </div>

                <button onClick={() => setShowUpgradeModal(false)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '500', cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Promotion Modal */}
          {showPromoModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>
                  {editingPromo ? 'Edit Promotion' : 'New Promotion'}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Title</label>
                    <input type="text" value={promoForm.title} onChange={(e) => setPromoForm({...promoForm, title: e.target.value})} placeholder="e.g., Half-Price Apps" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Description</label>
                    <input type="text" value={promoForm.desc} onChange={(e) => setPromoForm({...promoForm, desc: e.target.value})} placeholder="e.g., 50% off all appetizers" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Time Slot</label>
                    <select value={promoForm.time} onChange={(e) => setPromoForm({...promoForm, time: e.target.value})} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box', backgroundColor: 'white' }}>
                      <option value="Happy Hour">Happy Hour (4-7pm)</option>
                      <option value="Late Night">Late Night (10pm-close)</option>
                      <option value="Weekend Brunch">Weekend Brunch (10am-2pm)</option>
                      <option value="All Day">All Day</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Days Active</label>
                    <select value={promoForm.days} onChange={(e) => setPromoForm({...promoForm, days: e.target.value})} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box', backgroundColor: 'white' }}>
                      <option value="Daily">Daily</option>
                      <option value="Weekdays">Weekdays</option>
                      <option value="Weekends">Weekends</option>
                      <option value="Mon-Fri">Mon-Fri</option>
                      <option value="Fri-Sun">Fri-Sun</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button onClick={() => { setShowPromoModal(false); setEditingPromo(null); setPromoForm({ title: '', desc: '', time: 'Happy Hour', days: 'Daily' }); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={savePromo} disabled={!promoForm.title || !promoForm.desc} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: promoForm.title && promoForm.desc ? colors.navy : '#d1d5db', color: 'white', fontWeight: '600', cursor: promoForm.title && promoForm.desc ? 'pointer' : 'not-allowed' }}>
                    {editingPromo ? 'Save Changes' : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Event Modal */}
          {showEventModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>
                  {editingEvent ? 'Edit Event' : 'New Event'}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Event Title</label>
                    <input type="text" value={eventForm.title} onChange={(e) => setEventForm({...eventForm, title: e.target.value})} placeholder="e.g., Live Jazz Night" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Date</label>
                      <input type="text" value={eventForm.date} onChange={(e) => setEventForm({...eventForm, date: e.target.value})} placeholder="Jan 25" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Time</label>
                      <input type="text" value={eventForm.time} onChange={(e) => setEventForm({...eventForm, time: e.target.value})} placeholder="8:00 PM" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Capacity</label>
                    <input type="number" value={eventForm.capacity} onChange={(e) => setEventForm({...eventForm, capacity: e.target.value})} placeholder="50" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button onClick={() => { setShowEventModal(false); setEditingEvent(null); setEventForm({ title: '', date: '', time: '', capacity: '' }); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={saveEvent} disabled={!eventForm.title || !eventForm.date || !eventForm.time} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: eventForm.title && eventForm.date && eventForm.time ? colors.navy : '#d1d5db', color: 'white', fontWeight: '600', cursor: eventForm.title && eventForm.date && eventForm.time ? 'pointer' : 'not-allowed' }}>
                    {editingEvent ? 'Save Changes' : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Hours Modal */}
          {showHoursModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '340px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Edit Operating Hours</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {operatingHours.map((slot, index) => (
                    <div key={slot.days} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                      <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, width: '70px' }}>{slot.days}</span>
                      <select value={slot.open} onChange={(e) => { const updated = [...operatingHours]; updated[index].open = e.target.value; setOperatingHours(updated); }} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: '11px', backgroundColor: 'white' }}>
                        <option value="11:00 AM">11:00 AM</option>
                        <option value="12:00 PM">12:00 PM</option>
                        <option value="2:00 PM">2:00 PM</option>
                        <option value="4:00 PM">4:00 PM</option>
                        <option value="5:00 PM">5:00 PM</option>
                      </select>
                      <span style={{ fontSize: '11px', color: '#6b7280' }}>to</span>
                      <select value={slot.close} onChange={(e) => { const updated = [...operatingHours]; updated[index].close = e.target.value; setOperatingHours(updated); }} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: '11px', backgroundColor: 'white' }}>
                        <option value="10:00 PM">10:00 PM</option>
                        <option value="11:00 PM">11:00 PM</option>
                        <option value="12:00 AM">12:00 AM</option>
                        <option value="1:00 AM">1:00 AM</option>
                        <option value="2:00 AM">2:00 AM</option>
                      </select>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button onClick={() => setShowHoursModal(false)} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => { setShowHoursModal(false); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: colors.navy, color: 'white', fontWeight: '600', cursor: 'pointer' }}>Save Hours</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ADMIN DASHBOARD SCREEN
  const RevenueScreen = () => {
    // adminTab state is now at App level to persist across re-renders

    // Admin tabs definition
    const adminTabs = [
      { id: 'revenue', label: 'Revenue', icon: Icons.dollar },
      { id: 'users', label: 'Users', icon: Icons.users },
      { id: 'venues', label: 'Venues', icon: Icons.building },
      { id: 'cities', label: 'Cities', icon: Icons.map },
      { id: 'transactions', label: 'Txns', icon: Icons.creditCard },
      { id: 'projections', label: 'Project', icon: Icons.barChart }
    ];

    // Mock data for admin dashboard
    const adminUsers = [
      { id: 1, name: 'Emma Wilson', email: 'emma@email.com', joined: 'Jan 15', flocks: 11, status: 'active' },
      { id: 2, name: 'Jake Martinez', email: 'jake@email.com', joined: 'Jan 12', flocks: 4, status: 'active' },
      { id: 3, name: 'Sarah Chen', email: 'sarah@email.com', joined: 'Jan 10', flocks: 17, status: 'active' },
      { id: 4, name: 'Mike Johnson', email: 'mike@email.com', joined: 'Jan 8', flocks: 2, status: 'inactive' },
      { id: 5, name: 'Lisa Park', email: 'lisa@email.com', joined: 'Jan 5', flocks: 9, status: 'active' },
    ];

    const adminVenues = [
      { id: 1, name: "Blue Heron Bar", tier: 'pro', city: 'Easton', revenue: 2847, rating: 4.7 },
      { id: 2, name: "Porters Pub", tier: 'premium', city: 'Easton', revenue: 1923, rating: 4.6 },
      { id: 3, name: "The Bookstore Speakeasy", tier: 'free', city: 'Bethlehem', revenue: 487, rating: 4.4 },
      { id: 4, name: "Godfrey Daniels", tier: 'premium', city: 'Bethlehem', revenue: 1634, rating: 4.7 },
      { id: 5, name: "Rooftop @ The Grand", tier: 'pro', city: 'Easton', revenue: 2156, rating: 4.8 },
    ];

    const adminCities = [
      { name: 'Easton', users: 847, venues: 31, revenue: 14823, growth: 17 },
      { name: 'Bethlehem', users: 1089, venues: 38, revenue: 16247, growth: 14 },
      { name: 'Allentown', users: 623, venues: 19, revenue: 8934, growth: 11 },
    ];

    const adminTransactions = [
      { id: 'TXN-4821', date: 'Jan 19', venue: 'Blue Heron Bar', amount: 247, type: 'booking', status: 'completed' },
      { id: 'TXN-4820', date: 'Jan 19', venue: 'Porters Pub', amount: 175, type: 'subscription', status: 'completed' },
      { id: 'TXN-4819', date: 'Jan 18', venue: 'Godfrey Daniels', amount: 318, type: 'booking', status: 'pending' },
      { id: 'TXN-4818', date: 'Jan 18', venue: 'The Bookstore Speakeasy', amount: 75, type: 'subscription', status: 'completed' },
      { id: 'TXN-4817', date: 'Jan 17', venue: 'Rooftop @ The Grand', amount: 423, type: 'booking', status: 'completed' },
    ];

    // Revenue simulator state
    const [numVenues, setNumVenues] = useState(20);
    const [subscriptionPrice, setSubscriptionPrice] = useState(50);
    const [eventsPerVenue, setEventsPerVenue] = useState(12);
    const [avgSpend, setAvgSpend] = useState(120);
    const [takeRate, setTakeRate] = useState(2.5);
    const [operatingCosts, setOperatingCosts] = useState(2000);

    // Calculate all metrics
    const subscriptionRevenue = calculateSubscriptionRevenue(numVenues, subscriptionPrice);
    const transactionRevenue = calculateTransactionRevenue(numVenues, eventsPerVenue, avgSpend, takeRate);
    const totalMonthlyRevenue = calculateTotalMonthlyRevenue(subscriptionRevenue, transactionRevenue);
    const annualRevenue = calculateAnnualRevenue(totalMonthlyRevenue);
    const monthlyProfit = calculateMonthlyProfit(totalMonthlyRevenue, operatingCosts);
    const revenuePerVenue = calculateRevenuePerVenue(totalMonthlyRevenue, numVenues);
    const breakEvenVenues = calculateBreakEven(operatingCosts, subscriptionPrice, eventsPerVenue, avgSpend, takeRate);
    const profitMargin = calculateProfitMargin(monthlyProfit, totalMonthlyRevenue);
    const isProfitable = monthlyProfit >= 0;
    const isAboveBreakEven = numVenues >= breakEvenVenues;

    // Input field style
    const inputStyle = {
      width: '100%',
      padding: '10px 12px',
      borderRadius: '8px',
      border: `1px solid ${colors.creamDark}`,
      fontSize: '14px',
      fontWeight: '600',
      color: colors.navy,
      backgroundColor: 'white',
      outline: 'none',
      boxSizing: 'border-box',
    };

    const labelStyle = {
      fontSize: '11px',
      fontWeight: '700',
      color: colors.navy,
      marginBottom: '4px',
      display: 'block',
    };

    const helperStyle = {
      fontSize: '9px',
      color: '#9ca3af',
      marginTop: '2px',
    };

    const cardStyle = {
      backgroundColor: 'white',
      borderRadius: '12px',
      padding: '12px',
      marginBottom: '10px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    };

    return (
      <div key="revenue-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button onClick={switchMode} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            {Icons.briefcase('white', 24)}
            <div>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>Admin Dashboard</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Manage your Flock platform</p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', flexShrink: 0, padding: '8px 4px', gap: '4px' }}>
          {adminTabs.map(tab => (
            <button key={tab.id} onClick={() => setAdminTab(tab.id)} style={{ flex: 1, padding: '12px 4px', border: 'none', backgroundColor: adminTab === tab.id ? colors.navy : colors.cream, borderRadius: '10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', transition: 'all 0.2s' }}>
              {tab.icon(adminTab === tab.id ? 'white' : colors.navy, 18)}
              <span style={{ fontSize: '10px', fontWeight: '700', color: adminTab === tab.id ? 'white' : colors.navy }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* REVENUE TAB */}
          {adminTab === 'revenue' && (<>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>

            {/* LEFT COLUMN - INPUTS */}
            <div>
              <h3 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inputs</h3>

              {/* Number of Venues */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Number of Venues</label>
                <input
                  type="number"
                  value={numVenues}
                  onChange={(e) => setNumVenues(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Venues subscribed to Flock</p>
              </div>

              {/* Subscription Price */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Monthly Subscription</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={subscriptionPrice}
                    onChange={(e) => setSubscriptionPrice(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Monthly fee per venue</p>
              </div>

              {/* Events Per Venue */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Events Per Venue/Month</label>
                <input
                  type="number"
                  value={eventsPerVenue}
                  onChange={(e) => setEventsPerVenue(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Avg bookings per venue</p>
              </div>

              {/* Average Spend */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Avg Group Spend</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={avgSpend}
                    onChange={(e) => setAvgSpend(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Per event transaction</p>
              </div>

              {/* Take Rate */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Transaction Take Rate</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    value={takeRate}
                    onChange={(e) => setTakeRate(Math.max(0, parseFloat(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingRight: '28px' }}
                    min="0"
                    step="0.1"
                  />
                  <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>%</span>
                </div>
                <p style={helperStyle}>% of each transaction</p>
              </div>

              {/* Operating Costs */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Monthly Operating Costs</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={operatingCosts}
                    onChange={(e) => setOperatingCosts(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Fixed monthly expenses</p>
              </div>
            </div>

            {/* RIGHT COLUMN - OUTPUTS */}
            <div>
              <h3 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Results</h3>

              {/* Revenue Breakdown */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', margin: '0 0 8px', textTransform: 'uppercase' }}>Revenue Breakdown</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Subscriptions</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(subscriptionRevenue)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Transactions</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(transactionRevenue)}</span>
                </div>
                <div style={{ borderTop: `1px solid ${colors.creamDark}`, paddingTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: '700', color: colors.navy }}>Monthly Total</span>
                    <span style={{ fontSize: '18px', fontWeight: '900', color: colors.navy }}>{formatCurrency(totalMonthlyRevenue)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#6b7280' }}>Annual (ARR)</span>
                    <span style={{ fontSize: '12px', fontWeight: '700', color: colors.navyMid }}>{formatCurrency(annualRevenue)}</span>
                  </div>
                </div>
              </div>

              {/* Profitability */}
              <div style={{ ...cardStyle, background: isProfitable ? 'linear-gradient(135deg, #d1fae5, #a7f3d0)' : 'linear-gradient(135deg, #fee2e2, #fecaca)' }}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: isProfitable ? '#047857' : '#b91c1c', margin: '0 0 8px', textTransform: 'uppercase' }}>
                  {isProfitable ? 'Profitable' : 'Not Profitable'}
                </h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: isProfitable ? '#065f46' : '#991b1b' }}>Monthly Profit</span>
                  <span style={{ fontSize: '16px', fontWeight: '900', color: isProfitable ? '#047857' : '#b91c1c' }}>
                    {monthlyProfit >= 0 ? '+' : ''}{formatCurrency(monthlyProfit)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span style={{ fontSize: '10px', color: isProfitable ? '#065f46' : '#991b1b' }}>Profit Margin</span>
                  <span style={{ fontSize: '12px', fontWeight: '700', color: isProfitable ? '#047857' : '#b91c1c' }}>
                    {profitMargin.toFixed(1)}%
                  </span>
                </div>
              </div>

              {/* Unit Economics */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', margin: '0 0 8px', textTransform: 'uppercase' }}>Unit Economics</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Revenue/Venue</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(revenuePerVenue)}/mo</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Break-Even Point</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{breakEvenVenues} venues</span>
                </div>
                <div style={{ padding: '8px', borderRadius: '8px', backgroundColor: isAboveBreakEven ? '#d1fae5' : '#fef3c7', textAlign: 'center' }}>
                  <span style={{ fontSize: '10px', fontWeight: '700', color: isAboveBreakEven ? '#047857' : '#b45309' }}>
                    {isAboveBreakEven
                      ? `${numVenues - breakEvenVenues} venues above break-even`
                      : `Need ${breakEvenVenues - numVenues} more venues`}
                  </span>
                </div>
              </div>

              {/* Business Model Info */}
              <div style={{ ...cardStyle, backgroundColor: colors.cream, border: `1px solid ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: colors.navy, margin: '0 0 6px' }}>Business Model</h4>
                <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, lineHeight: '1.4' }}>
                  Flock generates revenue through <strong>venue subscriptions</strong> (recurring, predictable)
                  and <strong>transaction fees</strong> (scales with activity). This dual-revenue model provides
                  stability while capturing upside from platform growth.
                </p>
              </div>
            </div>
          </div>
          </>)}

          {/* USERS TAB */}
          {adminTab === 'users' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* User Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: 0 }}>3,200</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Total Users</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.teal, margin: 0 }}>2,850</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Active</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.amber, margin: 0 }}>+156</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>This Week</p>
                </div>
              </div>

              {/* User Growth Chart */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>User Growth (Last 7 Days)</h3>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '60px' }}>
                  {[45, 52, 38, 65, 78, 92, 110].map((val, i) => (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: '100%', height: `${val * 0.5}px`, backgroundColor: colors.navy, borderRadius: '4px 4px 0 0', minHeight: '4px' }} />
                      <span style={{ fontSize: '8px', color: '#9ca3af', marginTop: '4px' }}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'][i]}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent Users */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Recent Users</h3>
                {adminUsers.map(user => (
                  <div key={user.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '12px', fontWeight: '700' }}>
                        {user.name.charAt(0)}
                      </div>
                      <div>
                        <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{user.name}</p>
                        <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{user.email}</p>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: user.status === 'active' ? '#d1fae5' : '#fef3c7', color: user.status === 'active' ? '#047857' : '#b45309', fontSize: '9px', fontWeight: '600' }}>
                        {user.status}
                      </span>
                      <p style={{ fontSize: '9px', color: '#9ca3af', margin: '4px 0 0' }}>{user.flocks} flocks</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VENUES TAB */}
          {adminTab === 'venues' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Venue Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: 0 }}>117</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Total Venues</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: '#7c3aed', margin: 0 }}>28</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Pro Tier</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: '#b45309', margin: 0 }}>45</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Premium</p>
                </div>
              </div>

              {/* Tier Distribution */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Tier Distribution</h3>
                <div style={{ display: 'flex', height: '12px', borderRadius: '6px', overflow: 'hidden' }}>
                  <div style={{ width: '24%', backgroundColor: '#7c3aed' }} title="Pro" />
                  <div style={{ width: '38%', backgroundColor: '#b45309' }} title="Premium" />
                  <div style={{ width: '38%', backgroundColor: '#9ca3af' }} title="Free" />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px' }}>
                  <span style={{ fontSize: '9px', color: '#7c3aed', fontWeight: '600' }}>Pro 24%</span>
                  <span style={{ fontSize: '9px', color: '#b45309', fontWeight: '600' }}>Premium 38%</span>
                  <span style={{ fontSize: '9px', color: '#9ca3af', fontWeight: '600' }}>Free 38%</span>
                </div>
              </div>

              {/* Venue List */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Top Venues</h3>
                {adminVenues.map(venue => (
                  <div key={venue.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: venue.tier === 'pro' ? '#7c3aed' : venue.tier === 'premium' ? '#b45309' : colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {Icons.building('white', 16)}
                      </div>
                      <div>
                        <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                        <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{venue.city} • {venue.rating} {Icons.starFilled(colors.amber, 10)}</p>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>${venue.revenue}</p>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: venue.tier === 'pro' ? '#faf5ff' : venue.tier === 'premium' ? '#fffbeb' : colors.cream, color: venue.tier === 'pro' ? '#7c3aed' : venue.tier === 'premium' ? '#b45309' : '#6b7280', fontSize: '9px', fontWeight: '600' }}>
                        {venue.tier}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CITIES TAB */}
          {adminTab === 'cities' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* City Overview */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.map(colors.navy, 14)} Market Overview</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div style={{ backgroundColor: colors.cream, borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                    <p style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>4</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Active Cities</p>
                  </div>
                  <div style={{ backgroundColor: colors.cream, borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                    <p style={{ fontSize: '20px', fontWeight: '900', color: colors.teal, margin: 0 }}>$44.8K</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Total Revenue</p>
                  </div>
                </div>
              </div>

              {/* City Performance */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>City Performance</h3>
                {adminCities.map((city, i) => (
                  <div key={city.name} style={{ padding: '10px 0', borderBottom: i < adminCities.length - 1 ? `1px solid ${colors.cream}` : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <div>
                        <p style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{city.name}</p>
                        <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{city.users} users • {city.venues} venues</p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>${(city.revenue / 1000).toFixed(1)}K</p>
                        <span style={{ fontSize: '9px', color: colors.teal, fontWeight: '600' }}>+{city.growth}%</span>
                      </div>
                    </div>
                    <div style={{ height: '6px', backgroundColor: colors.cream, borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(city.revenue / 18500) * 100}%`, backgroundColor: colors.navy, borderRadius: '3px' }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Expansion Opportunities */}
              <div style={{ backgroundColor: colors.cream, borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '11px', fontWeight: '700', color: colors.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.globe(colors.teal, 12)} Expansion Targets</h4>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {['Denver', 'Phoenix', 'Nashville', 'Atlanta'].map(city => (
                    <span key={city} style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: 'white', fontSize: '10px', fontWeight: '500', color: colors.navy }}>
                      {city}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TRANSACTIONS TAB */}
          {adminTab === 'transactions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Transaction Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: '0 0 4px', textTransform: 'uppercase' }}>Today's Volume</p>
                  <p style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>$3,240</p>
                  <span style={{ fontSize: '10px', color: colors.teal }}>+18% vs yesterday</span>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: '0 0 4px', textTransform: 'uppercase' }}>This Month</p>
                  <p style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>$48.2K</p>
                  <span style={{ fontSize: '10px', color: colors.teal }}>+12% vs last month</span>
                </div>
              </div>

              {/* Transaction Type Breakdown */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>By Type</h3>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <div style={{ flex: 1, textAlign: 'center', padding: '10px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                    <p style={{ fontSize: '16px', fontWeight: '900', color: colors.navy, margin: 0 }}>68%</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: '4px 0 0' }}>Bookings</p>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center', padding: '10px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                    <p style={{ fontSize: '16px', fontWeight: '900', color: colors.navy, margin: 0 }}>32%</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: '4px 0 0' }}>Subscriptions</p>
                  </div>
                </div>
              </div>

              {/* Recent Transactions */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Recent Transactions</h3>
                {adminTransactions.map(txn => (
                  <div key={txn.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div>
                      <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>{txn.venue}</p>
                      <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{txn.id} • {txn.date}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>${txn.amount}</p>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'flex-end' }}>
                        <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: txn.type === 'booking' ? '#dbeafe' : '#fce7f3', color: txn.type === 'booking' ? '#1d4ed8' : '#be185d', fontSize: '8px', fontWeight: '600' }}>
                          {txn.type}
                        </span>
                        <span style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: txn.status === 'completed' ? colors.teal : colors.amber }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PROJECTIONS TAB */}
          {adminTab === 'projections' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Growth Projections */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.barChart(colors.navy, 14)} 12-Month Projection</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
                  {['Q1', 'Q2', 'Q3', 'Q4'].map((q, i) => (
                    <div key={q} style={{ textAlign: 'center' }}>
                      <div style={{ height: `${40 + i * 20}px`, backgroundColor: colors.navy, borderRadius: '4px', marginBottom: '4px', opacity: 0.3 + i * 0.2 }} />
                      <p style={{ fontSize: '10px', fontWeight: '600', color: colors.navy, margin: 0 }}>{q}</p>
                      <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>${[52, 78, 112, 156][i]}K</p>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '8px', backgroundColor: '#d1fae5', borderRadius: '8px', textAlign: 'center' }}>
                  <p style={{ fontSize: '10px', fontWeight: '700', color: '#047857', margin: 0 }}>Projected ARR: $624K (+200% YoY)</p>
                </div>
              </div>

              {/* Key Metrics Forecast */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>EOY Targets</h3>
                {[
                  { metric: 'Total Users', current: '3,200', target: '15,000', progress: 21 },
                  { metric: 'Active Venues', current: '117', target: '500', progress: 23 },
                  { metric: 'Cities', current: '4', target: '12', progress: 33 },
                  { metric: 'Monthly Revenue', current: '$18K', target: '$52K', progress: 35 },
                ].map(item => (
                  <div key={item.metric} style={{ marginBottom: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy }}>{item.metric}</span>
                      <span style={{ fontSize: '10px', color: '#6b7280' }}>{item.current} / {item.target}</span>
                    </div>
                    <div style={{ height: '6px', backgroundColor: colors.cream, borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${item.progress}%`, backgroundColor: colors.teal, borderRadius: '3px' }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Growth Levers */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Growth Levers</h3>
                {[
                  { lever: 'Venue Acquisition', impact: 'High', effort: 'Medium', icon: Icons.building },
                  { lever: 'User Referrals', impact: 'High', effort: 'Low', icon: Icons.users },
                  { lever: 'City Expansion', impact: 'Very High', effort: 'High', icon: Icons.globe },
                  { lever: 'Premium Upsells', impact: 'Medium', effort: 'Low', icon: Icons.sparkles },
                ].map(item => (
                  <div key={item.lever} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {item.icon(colors.navy, 14)}
                      <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy }}>{item.lever}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: item.impact === 'Very High' ? '#d1fae5' : item.impact === 'High' ? '#dbeafe' : '#fef3c7', color: item.impact === 'Very High' ? '#047857' : item.impact === 'High' ? '#1d4ed8' : '#b45309', fontSize: '8px', fontWeight: '600' }}>
                        {item.impact}
                      </span>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: colors.cream, color: '#6b7280', fontSize: '8px', fontWeight: '500' }}>
                        {item.effort}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Strategic Notes */}
              <div style={{ backgroundColor: colors.cream, borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '11px', fontWeight: '700', color: colors.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.sparkles(colors.amber, 12)} Key Insights</h4>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '10px', color: '#6b7280' }}>
                  <li>Austin market nearing saturation - prioritize Dallas/Houston</li>
                  <li>Pro tier conversion at 24% - above industry average</li>
                  <li>User acquisition cost trending down 15% MoM</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ONBOARDING SCREEN
  const vibeOptions = [
    { icon: Icons.cocktail, label: 'Cocktails' },
    { icon: Icons.music, label: 'Live Music' },
    { icon: Icons.beer, label: 'Beer & Brews' },
    { icon: Icons.sports, label: 'Sports' },
    { icon: Icons.partyPopper, label: 'Dancing' },
    { icon: Icons.mic, label: 'Karaoke' },
    { icon: Icons.laugh, label: 'Comedy' },
    { icon: Icons.wine, label: 'Wine' },
    { icon: Icons.gamepad, label: 'Gaming' },
    { icon: Icons.palette, label: 'Art & Culture' },
    { icon: Icons.pizza, label: 'Food' },
    { icon: Icons.coffee, label: 'Chill Vibes' },
  ];

  const completeOnboarding = () => {
    setOnboardingAnimating(true);
    setTimeout(() => {
      localStorage.setItem('flockOnboardingComplete', 'true');
      if (onboardingVibes.length > 0) {
        setUserInterests(onboardingVibes);
      }
      setHasCompletedOnboarding(true);
      setOnboardingAnimating(false);
         }, 1500);
  };

  const nextOnboardingStep = () => {
    setOnboardingAnimating(true);
    setTimeout(() => {
      setOnboardingStep(prev => prev + 1);
      setOnboardingAnimating(false);
    }, 300);
  };

  const OnboardingScreen = () => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: `linear-gradient(180deg, ${colors.cream} 0%, white 100%)`,
      overflow: 'hidden',
      position: 'relative'
    }}>
      {/* Decorative background circles */}
      <div style={{ position: 'absolute', top: '-100px', right: '-100px', width: '250px', height: '250px', borderRadius: '50%', background: `linear-gradient(135deg, ${colors.navy}10, ${colors.navyMid}05)`, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '-50px', left: '-50px', width: '150px', height: '150px', borderRadius: '50%', background: `linear-gradient(135deg, ${colors.teal}10, ${colors.teal}05)`, pointerEvents: 'none' }} />

      {/* Progress indicator */}
      <div style={{ padding: '24px 24px 0', flexShrink: 0, position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[0, 1].map(step => (
            <div
              key={step}
              style={{
                flex: 1,
                height: '4px',
                borderRadius: '4px',
                backgroundColor: step <= onboardingStep ? colors.navy : 'rgba(13,40,71,0.1)',
                transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
                transform: step <= onboardingStep ? 'scaleY(1.2)' : 'scaleY(1)'
              }}
            />
          ))}
        </div>
        <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '8px', textAlign: 'center' }}>Step {onboardingStep + 1} of 2</p>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 24px 24px',
        opacity: onboardingAnimating ? 0 : 1,
        transform: onboardingAnimating ? 'translateX(20px)' : 'translateX(0)',
        transition: 'opacity 0.3s, transform 0.3s',
        position: 'relative',
        zIndex: 1
      }}>
        {/* Step 0: Pick Interests */}
        {onboardingStep === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '12px', marginBottom: '24px' }}>
              <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(20,184,166,0.3)' }}>
                {Icons.heart('white', 28)}
              </div>
              <div>
                <h1 style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '0 0 4px' }}>
                  What's your vibe?
                </h1>
                <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>
                  Pick 3-5 interests so we can personalize your experience
                </p>
              </div>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '10px',
              flex: 1,
              overflow: 'auto',
              alignContent: 'start',
              marginBottom: '12px',
              paddingRight: '4px'
            }}>
              {vibeOptions.map(vibe => {
                const isSelected = onboardingVibes.includes(vibe.label);
                return (
                  <button
                    key={vibe.label}
                    onClick={() => {
                      if (isSelected) {
                        setOnboardingVibes(prev => prev.filter(v => v !== vibe.label));
                      } else {
                        setOnboardingVibes(prev => [...prev, vibe.label]);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '12px 16px',
                      borderRadius: '100px',
                      border: `2px solid ${isSelected ? colors.navy : colors.creamDark}`,
                      backgroundColor: isSelected ? colors.navy : 'white',
                      color: isSelected ? 'white' : colors.navy,
                      fontSize: '14px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      transform: isSelected ? 'scale(1.02)' : 'scale(1)'
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{vibe.icon(isSelected ? 'white' : colors.navy, 18)}</span>
                    {vibe.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '12px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: onboardingVibes.length > 0 ? colors.teal : '#d1d5db' }} />
              <p style={{ fontSize: '13px', color: onboardingVibes.length > 0 ? colors.teal : '#9ca3af', margin: 0, fontWeight: '600' }}>
                {onboardingVibes.length === 0
                  ? 'Select at least one'
                  : `${onboardingVibes.length} selected`}
              </p>
            </div>
            <button
              onClick={nextOnboardingStep}
              disabled={onboardingVibes.length === 0}
              style={{
                ...styles.gradientButton,
                padding: '16px 32px',
                fontSize: '15px',
                opacity: onboardingVibes.length > 0 ? 1 : 0.5,
                cursor: onboardingVibes.length > 0 ? 'pointer' : 'not-allowed'
              }}
            >
              Continue →
            </button>
          </div>
        )}

        {/* Step 1: All set */}
        {onboardingStep === 1 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
            <div style={{ position: 'relative', marginBottom: '32px' }}>
              <div style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #22C55E, #16A34A)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 20px 60px rgba(34,197,94,0.35)'
              }}>
                {Icons.check('white', 56)}
              </div>
              <div style={{ position: 'absolute', top: '-4px', right: '-4px', width: '36px', height: '36px', borderRadius: '50%', backgroundColor: colors.amber, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(245,158,11,0.4)' }}>
                {Icons.sparkles('white', 18)}
              </div>
            </div>
            <h1 style={{ fontSize: '28px', fontWeight: '900', color: colors.navy, margin: '0 0 8px', letterSpacing: '-0.5px' }}>
              You're all set{authUser?.name ? `, ${authUser.name}` : ''}!
            </h1>
            <p style={{ fontSize: '16px', color: colors.navyMid, margin: '0 0 12px', lineHeight: 1.5, fontWeight: '500' }}>
              Time to find your flock.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginBottom: '32px', maxWidth: '280px' }}>
              {onboardingVibes.slice(0, 4).map(vibe => (
                <span key={vibe} style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: 'rgba(13,40,71,0.08)', color: colors.navy, fontSize: '12px', fontWeight: '600' }}>{vibe}</span>
              ))}
              {onboardingVibes.length > 4 && <span style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: 'rgba(13,40,71,0.08)', color: colors.navy, fontSize: '12px', fontWeight: '600' }}>+{onboardingVibes.length - 4} more</span>}
            </div>
            <button
              onClick={completeOnboarding}
              disabled={onboardingAnimating}
              style={{
                ...styles.gradientButton,
                maxWidth: '280px',
                padding: '16px 32px',
                fontSize: '15px',
                opacity: onboardingAnimating ? 0.7 : 1
              }}
            >
              {onboardingAnimating ? 'Getting things ready...' : "Let's Flock →"}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // ADD FRIENDS SCREEN (Snapchat-style)
  const AddFriendsScreen = () => {
    const tabs = [
      { id: 'username', label: 'Search', icon: Icons.search },
      { id: 'suggestions', label: 'Quick Add', icon: Icons.users },
      { id: 'qr', label: 'QR', icon: Icons.layers },
      { id: 'contacts', label: 'Contacts', icon: Icons.phone },
    ];

    return (
      <div key="add-friends-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <button onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 18)}</button>
            <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0, flex: 1 }}>Add Friends</h1>
            {pendingRequests.length > 0 && (
              <span style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: colors.amber, color: 'white', fontSize: '12px', fontWeight: '700' }}>{pendingRequests.length} new</span>
            )}
          </div>

          {/* Tab Navigation */}
          <div style={{ display: 'flex', gap: '4px', paddingBottom: '2px' }}>
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setAddFriendsTab(tab.id)} style={{
                flex: 1, padding: '8px 4px', borderRadius: '16px', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: '700', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', transition: 'all 0.2s ease',
                backgroundColor: addFriendsTab === tab.id ? 'white' : 'rgba(255,255,255,0.15)',
                color: addFriendsTab === tab.id ? colors.navy : 'rgba(255,255,255,0.8)',
              }}>
                {tab.icon(addFriendsTab === tab.id ? colors.navy : 'rgba(255,255,255,0.8)', 16)}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* Pending Friend Requests (always visible at top if any) */}
          {pendingRequests.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <div style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.userPlus('#b45309', 14)}</div>
                <h3 style={{ fontSize: '14px', fontWeight: '800', color: colors.navy, margin: 0 }}>Friend Requests</h3>
                <span style={{ padding: '2px 8px', borderRadius: '10px', backgroundColor: colors.amber, color: 'white', fontSize: '11px', fontWeight: '700' }}>{pendingRequests.length}</span>
              </div>
              {pendingRequests.map(req => (
                <div key={req.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'white', marginBottom: '8px', border: `1.5px solid #fde68a`, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                  <div style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                    {req.profile_image_url ? <img src={req.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : req.name[0]?.toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '700', fontSize: '14px', color: colors.navy, margin: 0 }}>{req.name}</p>
                    <p style={{ fontSize: '10px', color: '#9ca3af', margin: '2px 0 0' }}>Wants to be your friend</p>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button onClick={(e) => { confirmClick(e); handleAcceptFriendRequest(req.id); }} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: '#22c55e', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>{Icons.check('white', 18)}</button>
                    <button onClick={() => handleDeclineFriendRequest(req.id)} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: '#f3f4f6', color: '#6b7280', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 16)}</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Outgoing Requests */}
          {outgoingRequests.length > 0 && addFriendsTab === 'username' && (
            <div style={{ marginBottom: '16px' }}>
              <h4 style={{ fontSize: '11px', fontWeight: '700', color: '#9ca3af', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sent Requests</h4>
              {outgoingRequests.map(req => (
                <div key={req.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '12px', backgroundColor: 'white', marginBottom: '6px' }}>
                  <div style={{ width: '38px', height: '38px', borderRadius: '19px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                    {req.profile_image_url ? <img src={req.profile_image_url} alt="" style={{ width: '38px', height: '38px', borderRadius: '19px', objectFit: 'cover' }} /> : req.name[0]?.toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '600', fontSize: '13px', color: colors.navy, margin: 0 }}>{req.name}</p>
                    <p style={{ fontSize: '10px', color: '#9ca3af', margin: '1px 0 0' }}>Pending</p>
                  </div>
                  <button onClick={() => handleCancelOutgoingRequest(req.id)} style={{ padding: '6px 12px', borderRadius: '16px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'white', color: '#6b7280', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                </div>
              ))}
            </div>
          )}

          {/* TAB: Add by Name */}
          {addFriendsTab === 'username' && (
            <div>
              <div style={{ position: 'relative', marginBottom: '12px' }}>
                <input type="text" value={addFriendsSearch} onChange={(e) => handleAddFriendsSearch(e.target.value)} placeholder="Search by name..." autoComplete="off"
                  style={{ width: '100%', padding: '12px 12px 12px 38px', borderRadius: '14px', border: `1.5px solid ${addFriendsSearch ? colors.navy : '#e2e8f0'}`, fontSize: '14px', outline: 'none', boxSizing: 'border-box', backgroundColor: 'white', fontWeight: '500', transition: 'all 0.2s ease' }}
                />
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(addFriendsSearch ? colors.navy : '#94a3b8', 16)}</span>
                {addFriendsSearch && <button onClick={() => { setAddFriendsSearch(''); setAddFriendsResults([]); }} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#94a3b8', 14)}</button>}
              </div>

              {addFriendsSearching && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ display: 'inline-block', width: '18px', height: '18px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <p style={{ fontSize: '12px', color: '#9ca3af', margin: '8px 0 0' }}>Searching...</p>
                </div>
              )}

              {!addFriendsSearching && addFriendsSearch.trim().length >= 1 && addFriendsResults.length === 0 && (
                <p style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center', padding: '24px 0', margin: 0 }}>No users found for "{addFriendsSearch}"</p>
              )}

              {!addFriendsSearching && addFriendsResults.map(user => {
                const status = friendStatuses[user.id] || 'none';
                return (
                  <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'white', marginBottom: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                    <div style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                      {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: '700', fontSize: '14px', color: colors.navy, margin: 0 }}>{user.name}</p>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      {status === 'accepted' ? (
                        <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: '#d1fae5', color: '#047857', fontSize: '12px', fontWeight: '700' }}>Friends</span>
                      ) : status === 'pending' ? (
                        <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: '#e5e7eb', color: '#6b7280', fontSize: '12px', fontWeight: '700' }}>Pending</span>
                      ) : (
                        <button onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '12px', fontWeight: '700', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                      )}
                      <button onClick={() => { setCurrentScreen('main'); startNewDmWithUser(user); }} style={{ padding: '8px 12px', borderRadius: '20px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>{Icons.messageSquare(colors.navy, 14)}</button>
                    </div>
                  </div>
                );
              })}

              {!addFriendsSearch && (
                <div style={{ textAlign: 'center', padding: '40px 16px' }}>
                  <div style={{ width: '56px', height: '56px', borderRadius: '28px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>{Icons.search(colors.navy, 24)}</div>
                  <p style={{ fontSize: '15px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>Find People</p>
                  <p style={{ fontSize: '12px', color: '#9ca3af', margin: 0 }}>Search by name to add friends</p>
                </div>
              )}
            </div>
          )}

          {/* TAB: Quick Add / Suggestions */}
          {addFriendsTab === 'suggestions' && (
            <div>
              {friendSuggestions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 16px' }}>
                  <div style={{ width: '56px', height: '56px', borderRadius: '28px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>{Icons.users(colors.navy, 24)}</div>
                  <p style={{ fontSize: '15px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>No Suggestions Yet</p>
                  <p style={{ fontSize: '12px', color: '#9ca3af', margin: 0 }}>Add more friends to see people you may know</p>
                </div>
              ) : (
                <>
                  <h3 style={{ fontSize: '14px', fontWeight: '800', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.zap(colors.amber, 16)} Quick Add</h3>
                  {friendSuggestions.map(user => {
                    const status = friendStatuses[user.id] || 'none';
                    return (
                      <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'white', marginBottom: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                        <div style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                          {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontWeight: '700', fontSize: '14px', color: colors.navy, margin: 0 }}>{user.name}</p>
                          <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0' }}>{user.mutual_count} mutual friend{parseInt(user.mutual_count) !== 1 ? 's' : ''}</p>
                        </div>
                        {status === 'accepted' ? (
                          <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: '#d1fae5', color: '#047857', fontSize: '12px', fontWeight: '700' }}>Friends</span>
                        ) : status === 'pending' ? (
                          <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: '#e5e7eb', color: '#6b7280', fontSize: '12px', fontWeight: '700' }}>Pending</span>
                        ) : (
                          <button onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '12px', fontWeight: '700', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* TAB: QR Code */}
          {addFriendsTab === 'qr' && (
            <div>
              {/* My QR Code */}
              <div style={{ textAlign: 'center', padding: '20px', backgroundColor: 'white', borderRadius: '20px', marginBottom: '16px', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
                <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 4px' }}>My Flock Code</h3>
                <p style={{ fontSize: '11px', color: '#9ca3af', margin: '0 0 16px' }}>Friends can scan this to add you</p>
                <div style={{ display: 'inline-block', padding: '16px', backgroundColor: 'white', borderRadius: '16px', border: `3px solid ${colors.cream}` }}>
                  {myFriendCode ? (
                    <QRCodeSVG value={JSON.stringify({ type: 'flock_friend', code: myFriendCode })} size={180} level="H" bgColor="white" fgColor={colors.navy} />
                  ) : (
                    <div style={{ width: '180px', height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: '20px', height: '20px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    </div>
                  )}
                </div>
                {myFriendCode && (
                  <div style={{ marginTop: '14px' }}>
                    <p style={{ fontSize: '10px', color: '#9ca3af', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Your Code</p>
                    <button onClick={() => { navigator.clipboard?.writeText(myFriendCode); showToast('Code copied!'); }} style={{ padding: '8px 20px', borderRadius: '10px', border: `2px solid ${colors.cream}`, backgroundColor: colors.cream, color: colors.navy, fontSize: '16px', fontWeight: '800', cursor: 'pointer', letterSpacing: '2px', fontFamily: 'monospace' }}>{myFriendCode}</button>
                    <p style={{ fontSize: '10px', color: '#9ca3af', margin: '6px 0 0' }}>Tap to copy</p>
                  </div>
                )}
              </div>

              {/* Scan button */}
              <button onClick={startQrScanner} style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '15px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '16px', boxShadow: '0 4px 12px rgba(13,40,71,0.2)' }}>
                {Icons.camera('white', 18)} Scan a Friend's Code
              </button>

              {/* Enter friend's code */}
              <div style={{ padding: '16px', backgroundColor: 'white', borderRadius: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                <h4 style={{ fontSize: '14px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>Or Enter Code Manually</h4>
                <p style={{ fontSize: '11px', color: '#9ca3af', margin: '0 0 10px' }}>Ask your friend for their Flock code</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input type="text" value={friendCodeInput} onChange={(e) => setFriendCodeInput(e.target.value.toUpperCase())} placeholder="FLOCK-XXXX" maxLength={15}
                    style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `1.5px solid ${friendCodeInput ? colors.navy : '#e2e8f0'}`, fontSize: '15px', fontWeight: '600', fontFamily: 'monospace', letterSpacing: '1px', outline: 'none', boxSizing: 'border-box', textAlign: 'center' }}
                  />
                  <button onClick={(e) => { if (!friendCodeLoading) { confirmClick(e); handleAddByCode(); } }} disabled={friendCodeLoading || !friendCodeInput.trim()}
                    style={{ padding: '12px 20px', borderRadius: '12px', border: 'none', background: friendCodeInput.trim() ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : '#e5e7eb', color: friendCodeInput.trim() ? 'white' : '#9ca3af', fontSize: '14px', fontWeight: '700', cursor: friendCodeInput.trim() ? 'pointer' : 'default', position: 'relative', overflow: 'hidden', opacity: friendCodeLoading ? 0.7 : 1 }}>
                    {friendCodeLoading ? '...' : 'Add'}
                  </button>
                </div>
              </div>

              {/* QR Scanner Modal */}
              {showQrScanner && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.95)', zIndex: 1000, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                    <button onClick={stopQrScanner} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 18)}</button>
                    <h3 style={{ fontSize: '16px', fontWeight: '800', color: 'white', margin: 0 }}>Scan Flock Code</h3>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                    <div id={qrScannerDivId} style={{ width: '100%', maxWidth: '340px', borderRadius: '20px', overflow: 'hidden' }} />
                    {qrScanError && (
                      <div style={{ marginTop: '16px', padding: '10px 20px', borderRadius: '12px', backgroundColor: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)' }}>
                        <p style={{ fontSize: '13px', color: '#fca5a5', margin: 0, textAlign: 'center' }}>{qrScanError}</p>
                      </div>
                    )}
                    <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', marginTop: '20px', textAlign: 'center' }}>Point your camera at a Flock QR code</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB: Contacts */}
          {addFriendsTab === 'contacts' && (
            <div>
              {contactsUsers.length > 0 ? (
                <>
                  <h3 style={{ fontSize: '14px', fontWeight: '800', color: colors.navy, margin: '0 0 10px' }}>Contacts on Flock</h3>
                  {contactsUsers.map(user => {
                    const status = friendStatuses[user.id] || user.friendship_status || 'none';
                    return (
                      <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'white', marginBottom: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                        <div style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                          {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontWeight: '700', fontSize: '14px', color: colors.navy, margin: 0 }}>{user.name}</p>
                          <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0' }}>From your contacts</p>
                        </div>
                        {status === 'accepted' ? (
                          <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: '#d1fae5', color: '#047857', fontSize: '12px', fontWeight: '700' }}>Friends</span>
                        ) : status === 'pending' ? (
                          <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: '#e5e7eb', color: '#6b7280', fontSize: '12px', fontWeight: '700' }}>Pending</span>
                        ) : (
                          <button onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '12px', fontWeight: '700', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                        )}
                      </div>
                    );
                  })}
                  <button onClick={handleSyncContacts} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontSize: '13px', fontWeight: '600', cursor: 'pointer', marginTop: '8px' }}>Refresh Contacts</button>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 16px' }}>
                  <div style={{ width: '64px', height: '64px', borderRadius: '32px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>{Icons.phone(colors.navy, 28)}</div>
                  <p style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: '0 0 6px' }}>Find Friends in Contacts</p>
                  <p style={{ fontSize: '12px', color: '#9ca3af', margin: '0 0 20px', lineHeight: '1.5' }}>
                    {contactsSupported
                      ? 'See which of your contacts are already on Flock'
                      : 'Contact sync is only available on mobile browsers (Chrome Android)'}
                  </p>
                  {contactsSupported && (
                    <button onClick={(e) => { confirmClick(e); handleSyncContacts(); }} disabled={contactsLoading}
                      style={{ padding: '14px 28px', borderRadius: '14px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '15px', fontWeight: '700', cursor: 'pointer', position: 'relative', overflow: 'hidden', opacity: contactsLoading ? 0.7 : 1 }}>
                      {contactsLoading ? 'Searching...' : 'Sync Contacts'}
                    </button>
                  )}
                  {!contactsSupported && (
                    <div style={{ padding: '12px', borderRadius: '12px', backgroundColor: '#fef3c7', border: '1px solid #fde68a' }}>
                      <p style={{ fontSize: '12px', color: '#92400e', margin: 0, fontWeight: '500' }}>Share your Flock Code with friends instead!</p>
                      <button onClick={() => setAddFriendsTab('qr')} style={{ marginTop: '8px', padding: '8px 16px', borderRadius: '10px', border: 'none', backgroundColor: colors.navy, color: 'white', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Go to QR Code</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <BottomNav />
      </div>
    );
  };

  // RENDER - Call functions directly instead of JSX to prevent component recreation
  const isExploreVisible = currentTab === 'explore' && currentScreen === 'main' && !showModeSelection && (userMode !== 'user' || hasCompletedOnboarding);

  const renderScreen = () => {
    // Show welcome screen for mode selection
    if (showModeSelection) return <WelcomeScreen />;
    // Show onboarding for new users
    if (userMode === 'user' && !hasCompletedOnboarding) return <OnboardingScreen />;
    if (currentScreen === 'addFriends') return AddFriendsScreen();
    if (currentScreen === 'create') return CreateScreen();
    if (currentScreen === 'join') return JoinScreen();
    if (currentScreen === 'detail') return FlockDetailScreen();
    if (currentScreen === 'chatDetail') return ChatDetailScreen();
    if (currentScreen === 'dmDetail') return dmDetailScreen;
    if (currentScreen === 'venueDashboard') return <VenueDashboard />;
    if (currentScreen === 'adminRevenue') return <RevenueScreen />;
    switch (currentTab) {
      case 'explore': return null; // Rendered persistently below
      case 'calendar': return CalendarScreen();
      case 'chat': return ChatListScreen();
      case 'profile': return ProfileScreen();
      default: return HomeScreen();
    }
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <style>{`
        .btn-confirmed { position: relative !important; overflow: hidden !important; pointer-events: none !important; }
        .btn-confirmed::after {
          content: '✓';
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          background: #22c55e; color: white;
          font-size: 18px; font-weight: 800;
          border-radius: inherit;
          animation: confirmPop 1.1s ease-out forwards;
        }
        @keyframes confirmPop {
          0% { opacity: 0; transform: scale(0.5); }
          15% { opacity: 1; transform: scale(1.1); }
          25% { transform: scale(1); }
          75% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
      <div style={styles.phoneContainer}>
        <div style={styles.notch}>
          <div style={styles.notchInner} />
        </div>
        <div style={styles.content}>
          {/* Persistent map layer — hidden via CSS, never unmounted */}
          <div style={{ position: 'absolute', inset: 0, zIndex: isExploreVisible ? 1 : -1, visibility: isExploreVisible ? 'visible' : 'hidden', pointerEvents: isExploreVisible ? 'auto' : 'none' }}>
            {ExploreScreen()}
          </div>
          {renderScreen()}

          {/* Full-screen venue search results overlay */}
          {showSearchResults && (() => {
            const calcDist = (vLoc) => {
              if (!userLocation || !vLoc) return null;
              const dLat = (vLoc.latitude - userLocation.lat) * Math.PI / 180;
              const dLng = (vLoc.longitude - userLocation.lng) * Math.PI / 180;
              const a = Math.sin(dLat/2)**2 + Math.cos(userLocation.lat*Math.PI/180)*Math.cos(vLoc.latitude*Math.PI/180)*Math.sin(dLng/2)**2;
              return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            };

            const sorted = [...allVenues].sort((a, b) => {
              if (searchResultsSort === 'rating') return (b.stars || 0) - (a.stars || 0);
              if (searchResultsSort === 'distance') {
                const dA = calcDist(a.location);
                const dB = calcDist(b.location);
                if (dA == null && dB == null) return 0;
                if (dA == null) return 1;
                if (dB == null) return -1;
                return dA - dB;
              }
              // 'recommended' - AI interest matching (coming soon), using weighted score for now
              const scoreA = (a.stars || 0) * 20 - (a.crowd || 50) + (a.trending ? 30 : 0);
              const scoreB = (b.stars || 0) * 20 - (b.crowd || 50) + (b.trending ? 30 : 0);
              return scoreB - scoreA;
            });

            return (
              <div style={{ position: 'absolute', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column', backgroundColor: '#f0ede6' }}>
                {/* Search bar header */}
                <div style={{ backgroundColor: 'white', flexShrink: 0, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
                  <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ flex: 1, position: 'relative' }}>
                      <input
                        ref={searchResultsInputRef}
                        type="text"
                        value={venueQuery}
                        onChange={(e) => handleVenueQueryChange(e.target.value)}
                        placeholder="Search restaurants, bars, venues..."
                        style={{ width: '100%', padding: '12px 40px 12px 38px', borderRadius: '14px', backgroundColor: '#f8fafc', border: `2px solid ${venueQuery ? colors.navy : '#e2e8f0'}`, fontSize: '13px', outline: 'none', boxSizing: 'border-box', transition: 'all 0.2s ease', fontWeight: '500' }}
                        autoComplete="off"
                        autoFocus
                      />
                      <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(venueQuery ? colors.navy : '#94a3b8', 16)}</span>
                      {venueQuery && (
                        <button onClick={() => { setShowSearchResults(false); setVenueQuery(''); setVenueResults([]); setShowSearchDropdown(false); }} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>{Icons.x('#94a3b8', 16)}</button>
                      )}
                    </div>
                  </div>

                  {/* Back to map + count + sort */}
                  <div style={{ padding: '0 12px 10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button onClick={() => setShowSearchResults(false)} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', flexShrink: 0 }}>
                      {Icons.arrowLeft(colors.navy, 14)}
                      <span style={{ fontSize: '12px', fontWeight: '600', color: colors.navy }}>Map</span>
                    </button>
                    <div style={{ width: '1px', height: '16px', backgroundColor: '#e5e7eb', flexShrink: 0 }} />
                    <span style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', flexShrink: 0 }}>{sorted.length} result{sorted.length !== 1 ? 's' : ''}</span>
                    <div style={{ flex: 1 }} />
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {[
                        { id: 'rating', label: 'Best Rated' },
                        { id: 'recommended', label: 'Recommended' },
                        { id: 'distance', label: 'Closest' },
                      ].map(s => (
                        <button key={s.id} onClick={() => setSearchResultsSort(s.id)} style={{ padding: '5px 10px', borderRadius: '8px', border: 'none', backgroundColor: searchResultsSort === s.id ? colors.navy : '#f3f4f6', color: searchResultsSort === s.id ? 'white' : '#6b7280', fontSize: '10px', fontWeight: '700', cursor: 'pointer', transition: 'all 0.15s' }}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Loading spinner */}
                {venueSearching && (
                  <div style={{ padding: '24px 0', textAlign: 'center', flexShrink: 0 }}>
                    <div style={{ display: 'inline-block', width: '20px', height: '20px', border: `3px solid #e5e7eb`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    <p style={{ fontSize: '11px', color: '#6b7280', margin: '8px 0 0' }}>Searching...</p>
                  </div>
                )}

                {/* Results list */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 80px' }}>
                  {!venueSearching && sorted.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', opacity: 0.6 }}>
                      {Icons.search('#9ca3af', 40)}
                      <p style={{ fontSize: '14px', color: '#9ca3af', fontWeight: '600', margin: '12px 0 4px' }}>No venues found</p>
                      <p style={{ fontSize: '12px', color: '#b0b0b0', margin: 0 }}>Try a different search or location</p>
                    </div>
                  ) : !venueSearching && sorted.map((venue) => {
                    const dist = calcDist(venue.location);
                    const crowdColor = venue.crowd > 70 ? '#EF4444' : venue.crowd > 40 ? '#F59E0B' : '#22C55E';
                    const crowdLabel = venue.crowd > 70 ? 'Busy' : venue.crowd > 40 ? 'Moderate' : 'Not Busy';
                    const forecastBars = [30, 35, 45, 55, 70, 85, 90, 80, 65, 50, 35, 25].map(h => {
                      const seed = ((venue.place_id || '').charCodeAt(2) || 0);
                      return Math.max(15, Math.min(95, h + ((seed * 7) % 30) - 15));
                    });

                    return (
                      <button
                        key={venue.place_id || venue.id}
                        onClick={() => {
                          setShowSearchResults(false);
                          if (window.__flockPanToVenue) window.__flockPanToVenue(venue.place_id || venue);
                          openVenueDetail(venue.place_id, { name: venue.name, formatted_address: venue.addr, place_id: venue.place_id, rating: venue.stars, price_level: venue.price ? venue.price.length : null, photo_url: venue.photo_url });
                        }}
                        style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: '16px', border: '1px solid #f0f0f0', padding: 0, marginBottom: '10px', cursor: 'pointer', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s' }}
                      >
                        {/* Photo + overlay info */}
                        <div style={{ position: 'relative', height: venue.photo_url ? '120px' : '0' }}>
                          {venue.photo_url && (
                            <>
                              <img src={venue.photo_url} alt="" style={{ width: '100%', height: '120px', objectFit: 'cover', display: 'block' }} onError={(e) => { e.target.style.display = 'none'; e.target.parentElement.style.height = '0'; }} />
                              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(transparent 40%, rgba(0,0,0,0.6) 100%)' }} />
                              {venue.trending && (
                                <div style={{ position: 'absolute', top: '8px', left: '8px', padding: '3px 8px', borderRadius: '8px', backgroundColor: 'rgba(245,158,11,0.9)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                  {Icons.flame('#fff', 10)}
                                  <span style={{ fontSize: '9px', fontWeight: '700', color: 'white' }}>Trending</span>
                                </div>
                              )}
                              <div style={{ position: 'absolute', top: '8px', right: '8px', padding: '4px 8px', borderRadius: '10px', backgroundColor: `${crowdColor}18`, backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: crowdColor }} />
                                <span style={{ fontSize: '10px', fontWeight: '700', color: crowdColor }}>{venue.crowd}%</span>
                              </div>
                            </>
                          )}
                        </div>

                        {/* Content */}
                        <div style={{ padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <h3 style={{ fontSize: '15px', fontWeight: '800', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</h3>
                              <p style={{ fontSize: '11px', color: '#8b8b8b', margin: '2px 0 0', fontWeight: '500' }}>{venue.type}{venue.price ? ` • ${venue.price}` : ''}</p>
                            </div>
                            {venue.stars && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', padding: '3px 8px', borderRadius: '8px', backgroundColor: '#FEF3C7', flexShrink: 0 }}>
                                {Icons.starFilled('#F59E0B', 12)}
                                <span style={{ fontSize: '12px', fontWeight: '800', color: '#92400E' }}>{venue.stars}</span>
                              </div>
                            )}
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                            {dist != null && (
                              <span style={{ fontSize: '11px', fontWeight: '600', color: colors.teal, display: 'flex', alignItems: 'center', gap: '3px' }}>
                                {Icons.mapPin(colors.teal, 11)} {dist < 1 ? `${Math.round(dist*1000)}m` : `${dist.toFixed(1)}km`}
                              </span>
                            )}
                            {!venue.photo_url && (
                              <span style={{ fontSize: '10px', fontWeight: '600', color: crowdColor, backgroundColor: `${crowdColor}12`, padding: '2px 8px', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                <div style={{ width: '5px', height: '5px', borderRadius: '3px', backgroundColor: crowdColor }} />
                                {crowdLabel} {venue.crowd}%
                              </span>
                            )}
                            <span style={{ fontSize: '10px', fontWeight: '600', color: colors.navy, display: 'flex', alignItems: 'center', gap: '3px' }}>
                              {Icons.clock(colors.navy, 10)} Best: {venue.best}
                            </span>
                          </div>

                          {venue.addr && (
                            <p style={{ fontSize: '11px', color: '#9ca3af', margin: '0 0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.addr}</p>
                          )}

                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '28px' }}>
                            {forecastBars.map((h, i) => (
                              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px' }}>
                                <div style={{ width: '100%', height: `${h * 0.28}px`, borderRadius: '1.5px', backgroundColor: h > 70 ? '#EF444440' : h > 40 ? '#F59E0B40' : '#22C55E40', transition: 'height 0.3s' }} />
                              </div>
                            ))}
                            <span style={{ fontSize: '8px', color: '#b0b0b0', marginLeft: '4px', whiteSpace: 'nowrap', flexShrink: 0 }}>6p-5a</span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
      <Toast />

      {/* Camera Viewfinder */}
      {showCameraViewfinder && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', zIndex: 9999, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 }}>
            <button onClick={closeCameraViewfinder} style={{ width: '40px', height: '40px', borderRadius: '20px', border: 'none', backgroundColor: 'rgba(0,0,0,0.5)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 20)}</button>
            <span style={{ fontSize: '15px', fontWeight: '700', color: 'white' }}>Take Photo</span>
            <div style={{ width: '40px' }} />
          </div>
          <video ref={cameraVideoRef} autoPlay playsInline muted style={{ flex: 1, objectFit: 'cover', width: '100%' }} />
          <div style={{ padding: '24px 0 36px', display: 'flex', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)' }}>
            <button onClick={capturePhoto} style={{ width: '72px', height: '72px', borderRadius: '36px', border: '4px solid white', backgroundColor: 'rgba(255,255,255,0.3)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s ease' }}>
              <div style={{ width: '56px', height: '56px', borderRadius: '28px', backgroundColor: 'white' }} />
            </button>
          </div>
        </div>
      )}

      {/* Venue Details Modal */}
      {venueDetailModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setVenueDetailModal(null); }}
        >
          <div style={{ width: '100%', maxWidth: '420px', maxHeight: '92vh', backgroundColor: colors.cream, borderRadius: '20px', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            {/* Photo area */}
            <div style={{ position: 'relative', height: '220px', flexShrink: 0, overflow: 'hidden' }}>
              {venueDetailModal.photos && venueDetailModal.photos.length > 0 ? (
                <>
                  <img src={venueDetailModal.photos[venueDetailPhotoIdx] || venueDetailModal.photos[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={(e) => { e.target.src = ''; e.target.parentElement.style.background = `linear-gradient(135deg, #0d2847, #1a3a5c)`; e.target.style.display = 'none'; }} />
                  {venueDetailModal.photos.length > 1 && (
                    <>
                      <button onClick={(e) => { e.stopPropagation(); setVenueDetailPhotoIdx(i => i > 0 ? i - 1 : venueDetailModal.photos.length - 1); }} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'rgba(0,0,0,0.5)', border: 'none', color: 'white', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>‹</button>
                      <button onClick={(e) => { e.stopPropagation(); setVenueDetailPhotoIdx(i => i < venueDetailModal.photos.length - 1 ? i + 1 : 0); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'rgba(0,0,0,0.5)', border: 'none', color: 'white', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>›</button>
                      <div style={{ position: 'absolute', bottom: '10px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '5px' }}>
                        {venueDetailModal.photos.map((_, i) => (
                          <div key={i} style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: i === venueDetailPhotoIdx ? 'white' : 'rgba(255,255,255,0.4)', transition: 'background-color 0.2s' }} />
                        ))}
                      </div>
                    </>
                  )}
                </>
              ) : venueDetailModal.photo_url ? (
                <img src={venueDetailModal.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={(e) => { e.target.src = ''; e.target.style.display = 'none'; e.target.parentElement.style.background = `linear-gradient(135deg, #0d2847, #1a3a5c)`; }} />
              ) : (
                <div style={{ width: '100%', height: '100%', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.mapPin('rgba(255,255,255,0.3)', 48)}</div>
              )}
              {/* Overlay gradient */}
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '80px', background: 'linear-gradient(transparent, rgba(0,0,0,0.7))' }} />
              {/* Close button */}
              <button onClick={() => setVenueDetailModal(null)} style={{ position: 'absolute', top: '12px', right: '12px', width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'rgba(0,0,0,0.5)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>{Icons.x('white', 18)}</button>
              {/* Name overlay */}
              <div style={{ position: 'absolute', bottom: '12px', left: '14px', right: '14px' }}>
                <h2 style={{ color: 'white', fontSize: '20px', fontWeight: '900', margin: 0, textShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>{venueDetailModal.name}</h2>
                {venueDetailModal.formatted_address && <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: '12px', margin: '3px 0 0', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>{venueDetailModal.formatted_address}</p>}
              </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
              {venueDetailModal.loading ? (
                <div style={{ textAlign: 'center', padding: '30px 0' }}>
                  <div style={{ display: 'inline-block', width: '24px', height: '24px', border: `3px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <p style={{ fontSize: '12px', color: '#6b7280', margin: '10px 0 0' }}>Loading details...</p>
                </div>
              ) : (
                <>
                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                    {venueDetailModal.rating && (
                      <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '12px', padding: '10px', textAlign: 'center', border: '1px solid rgba(0,0,0,0.06)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px', marginBottom: '2px' }}>
                          {Icons.starFilled('#F59E0B', 16)}
                          <span style={{ fontSize: '18px', fontWeight: '900', color: colors.navy }}>{venueDetailModal.rating}</span>
                        </div>
                        <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{venueDetailModal.user_ratings_total ? `${venueDetailModal.user_ratings_total} reviews` : 'Rating'}</p>
                      </div>
                    )}
                    {venueDetailModal.price_level != null && (
                      <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '12px', padding: '10px', textAlign: 'center', border: '1px solid rgba(0,0,0,0.06)' }}>
                        <p style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 2px' }}>{'$'.repeat(venueDetailModal.price_level || 1)}</p>
                        <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>Price</p>
                      </div>
                    )}
                    {venueDetailModal.opening_hours && (
                      <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '12px', padding: '10px', textAlign: 'center', border: '1px solid rgba(0,0,0,0.06)' }}>
                        <div style={{ marginBottom: '2px' }}>{Icons.clock(venueDetailModal.opening_hours.openNow ? colors.teal : colors.red, 18)}</div>
                        <p style={{ fontSize: '10px', color: venueDetailModal.opening_hours.openNow ? colors.teal : colors.red, fontWeight: '600', margin: 0 }}>{venueDetailModal.opening_hours.openNow ? 'Open Now' : 'Closed'}</p>
                      </div>
                    )}
                  </div>

                  {/* Hours */}
                  {venueDetailModal.opening_hours?.weekdayDescriptions && (
                    <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '14px', border: '1px solid rgba(0,0,0,0.06)' }}>
                      <h4 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.clock(colors.navy, 14)} Hours</h4>
                      {venueDetailModal.opening_hours.weekdayDescriptions.map((day, i) => {
                        const today = new Date().getDay();
                        const isToday = i === (today === 0 ? 6 : today - 1);
                        return <p key={i} style={{ fontSize: '11px', color: isToday ? colors.navy : '#6b7280', fontWeight: isToday ? '700' : '400', margin: '3px 0', padding: isToday ? '3px 6px' : '0', backgroundColor: isToday ? `${colors.navy}10` : 'transparent', borderRadius: '6px' }}>{day}</p>;
                      })}
                    </div>
                  )}

                  {/* Contact */}
                  {(venueDetailModal.formatted_phone_number || venueDetailModal.website) && (
                    <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '14px', border: '1px solid rgba(0,0,0,0.06)' }}>
                      <h4 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 8px' }}>Contact</h4>
                      {venueDetailModal.formatted_phone_number && (
                        <a href={`tel:${venueDetailModal.formatted_phone_number}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', backgroundColor: colors.cream, borderRadius: '10px', textDecoration: 'none', marginBottom: venueDetailModal.website ? '6px' : 0 }}>
                          {Icons.wave(colors.navy, 16)}
                          <span style={{ fontSize: '13px', fontWeight: '600', color: colors.navy }}>{venueDetailModal.formatted_phone_number}</span>
                        </a>
                      )}
                      {venueDetailModal.website && (
                        <a href={venueDetailModal.website} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', backgroundColor: colors.cream, borderRadius: '10px', textDecoration: 'none' }}>
                          {Icons.externalLink(colors.navy, 16)}
                          <span style={{ fontSize: '13px', fontWeight: '600', color: colors.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Website</span>
                        </a>
                      )}
                    </div>
                  )}

                  {/* View Menu */}
                  {!venueDetailModal.loading && (
                    <a href={venueDetailModal.menu_url || `https://www.google.com/search?q=${encodeURIComponent((venueDetailModal.name || '') + ' ' + (venueDetailModal.formatted_address || '') + ' menu')}`} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', backgroundColor: 'white', borderRadius: '12px', border: '1px solid rgba(0,0,0,0.06)', textDecoration: 'none', marginBottom: '14px', transition: 'background-color 0.15s' }}>
                      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.navy} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="10" x2="20" y2="10"></line><line x1="4" y1="14" x2="16" y2="14"></line><line x1="4" y1="18" x2="12" y2="18"></line></svg>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: '13px', fontWeight: '700', color: colors.navy }}>View Menu</span>
                        <p style={{ fontSize: '10px', color: '#6b7280', margin: '1px 0 0' }}>{venueDetailModal.menu_url ? 'Official menu' : 'Search online'}</p>
                      </div>
                      {Icons.externalLink('#9ca3af', 14)}
                    </a>
                  )}

                  {/* Types/Tags */}
                  {venueDetailModal.types && venueDetailModal.types.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px' }}>
                      {venueDetailModal.types.slice(0, 6).map((t, i) => (
                        <span key={i} style={{ fontSize: '10px', padding: '4px 10px', borderRadius: '20px', backgroundColor: 'white', color: colors.navy, fontWeight: '600', border: '1px solid rgba(0,0,0,0.06)' }}>{t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Bottom action buttons */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(0,0,0,0.08)', backgroundColor: 'white', flexShrink: 0, display: 'flex', gap: '8px' }}>
              {venueDetailModal.google_maps_url ? (
                <a href={venueDetailModal.google_maps_url} target="_blank" rel="noopener noreferrer" style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontSize: '13px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', textDecoration: 'none' }}>
                  {Icons.mapPin(colors.navy, 16)} Get Directions
                </a>
              ) : venueDetailModal.place_id ? (
                <a href={`https://www.google.com/maps/place/?q=place_id:${venueDetailModal.place_id}`} target="_blank" rel="noopener noreferrer" style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontSize: '13px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', textDecoration: 'none' }}>
                  {Icons.mapPin(colors.navy, 16)} Get Directions
                </a>
              ) : null}
              <button onClick={(e) => {
                confirmClick(e);
                const photoUrl = (venueDetailModal.photos && venueDetailModal.photos[0]) || venueDetailModal.photo_url || null;
                if (pickingVenueForDm) {
                  const v = { name: venueDetailModal.name, addr: venueDetailModal.formatted_address, place_id: venueDetailModal.place_id, rating: venueDetailModal.rating, photo_url: photoUrl };
                  setDmPinnedVenue(v);
                  dmPinVenue(selectedDmId, v);
                  setVenueDetailModal(null);
                  setPickingVenueForCreate(false);
                  setPickingVenueForDm(false);
                  setCurrentTab('chats');
                  setCurrentScreen('dmDetail');
                } else if (pickingVenueForFlockId) {
                  updateFlockVenue(pickingVenueForFlockId, { name: venueDetailModal.name, addr: venueDetailModal.formatted_address, place_id: venueDetailModal.place_id, rating: venueDetailModal.rating, photo_url: photoUrl, lat: venueDetailModal.location?.latitude, lng: venueDetailModal.location?.longitude });
                  setVenueDetailModal(null);
                  setPickingVenueForCreate(false);
                  setSelectedFlockId(pickingVenueForFlockId);
                  setPickingVenueForFlockId(null);
                  setCurrentTab('chats');
                  setCurrentScreen('chatDetail');
                } else {
                  setSelectedVenueForCreate({ name: venueDetailModal.name, addr: venueDetailModal.formatted_address, place_id: venueDetailModal.place_id, rating: venueDetailModal.rating, stars: venueDetailModal.rating, price_level: venueDetailModal.price_level, price: venueDetailModal.price_level ? '$'.repeat(venueDetailModal.price_level) : null, photo_url: photoUrl, type: venueDetailModal.types?.[0]?.replace(/_/g, ' ')?.replace(/\b\w/g, c => c.toUpperCase()) || 'Venue', crowd: Math.round(20 + Math.random() * 60), lat: venueDetailModal.location?.latitude, lng: venueDetailModal.location?.longitude });
                  setVenueDetailModal(null);
                  setCurrentScreen('create');
                }
              }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '13px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(13,40,71,0.3)', position: 'relative', overflow: 'hidden' }}>
                {Icons.plus('white', 16)} {pickingVenueForDm ? 'Pin to DM' : 'Add to Flock'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Story Viewer Overlay */}
      {viewingStory && viewingStory.storyData && viewingStory.storyData.length > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.95)', zIndex: 9999, display: 'flex', flexDirection: 'column' }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            if (x > rect.width / 2) {
              if (storyIndex < viewingStory.storyData.length - 1) setStoryIndex(storyIndex + 1);
              else setViewingStory(null);
            } else {
              if (storyIndex > 0) setStoryIndex(storyIndex - 1);
            }
          }}
        >
          {/* Progress bars */}
          <div style={{ display: 'flex', gap: '3px', padding: '12px 12px 0', flexShrink: 0 }}>
            {viewingStory.storyData.map((_, i) => (
              <div key={i} style={{ flex: 1, height: '3px', borderRadius: '2px', backgroundColor: i <= storyIndex ? 'white' : 'rgba(255,255,255,0.3)' }} />
            ))}
          </div>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>{viewingStory.avatar}</div>
              <div>
                <p style={{ fontSize: '14px', fontWeight: '700', color: 'white', margin: 0 }}>{viewingStory.name}</p>
                <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                  {(() => { const h = Math.round((Date.now() - new Date(viewingStory.storyData[storyIndex].created_at).getTime()) / 3600000); return h < 1 ? 'Just now' : `${h}h ago`; })()}
                </p>
              </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); setViewingStory(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px' }}>{Icons.x('white', 24)}</button>
          </div>
          {/* Image */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: '0 8px' }}>
            <img src={viewingStory.storyData[storyIndex].image_url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: '12px', objectFit: 'contain' }} />
          </div>
          {/* Caption */}
          {viewingStory.storyData[storyIndex].caption && (
            <div style={{ padding: '16px', textAlign: 'center', flexShrink: 0 }}>
              <p style={{ fontSize: '16px', fontWeight: '600', color: 'white', margin: 0, textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>{viewingStory.storyData[storyIndex].caption}</p>
            </div>
          )}
        </div>
      )}
      <SOSModal />
      <CheckinModal />
      <ProfilePicModal />
      {aiAssistantModal}
      {adminPromptModal}
      <NewDmModal />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.8; transform: translate(-50%, -50%) scale(1.2); }
        }
        @keyframes heatPulseOuter {
          0%, 100% { opacity: 0.3; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.6; transform: translate(-50%, -50%) scale(1.15); }
        }
        @keyframes heatPulseMiddle {
          0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.7; transform: translate(-50%, -50%) scale(1.12); }
        }
        @keyframes heatPulseInner {
          0%, 100% { opacity: 0.5; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.85; transform: translate(-50%, -50%) scale(1.08); }
        }
        @keyframes heatPulseCore {
          0%, 100% { opacity: 0.6; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); }
        }
        @keyframes heatGlow {
          0%, 100% { opacity: 0.8; filter: blur(0px); }
          50% { opacity: 1; filter: blur(2px); }
        }
        @keyframes trendingBounce {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-2px) rotate(-5deg); }
          75% { transform: translateY(-2px) rotate(5deg); }
        }
        @keyframes pinRingPulse {
          0% { opacity: 0.6; transform: translateX(-50%) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) scale(1.8); }
        }
@keyframes tooltipFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(4px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes userLocationPulse {
          0% { opacity: 0.8; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(2.5); }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 5px rgba(13,40,71,0.3); }
          50% { box-shadow: 0 0 20px rgba(13,40,71,0.5); }
        }
        @keyframes tabBounce {
          0% { transform: scale(1); }
          25% { transform: scale(0.9); }
          50% { transform: scale(1.15); }
          75% { transform: scale(0.95); }
          100% { transform: scale(1); }
        }
        @keyframes cardSlideIn {
          from { opacity: 0; transform: translateY(20px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes buttonPress {
          0% { transform: scale(1); }
          50% { transform: scale(0.95); }
          100% { transform: scale(1); }
        }
        @keyframes ripple {
          0% { transform: scale(0); opacity: 0.5; }
          100% { transform: scale(4); opacity: 0; }
        }
        @keyframes reactionPop {
          0% { transform: scale(0); }
          50% { transform: scale(1.4); }
          75% { transform: scale(0.9); }
          100% { transform: scale(1); }
        }
        @keyframes typingDot {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-6px); }
        }
        @keyframes toastSlideIn {
          from { transform: translateY(-100%) scale(0.9); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        @keyframes toastSlideOut {
          from { transform: translateY(0) scale(1); opacity: 1; }
          to { transform: translateY(-100%) scale(0.9); opacity: 0; }
        }
        @keyframes modalBlurIn {
          from { backdrop-filter: blur(0px); background-color: rgba(0,0,0,0); }
          to { backdrop-filter: blur(8px); background-color: rgba(0,0,0,0.5); }
        }
        @keyframes modalSlideIn {
          from { transform: translateY(50px) scale(0.95); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        @keyframes progressFill {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }
        @keyframes screenSlideIn {
          from { opacity: 0; transform: translateX(30px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes screenSlideOut {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(-30px); }
        }
        @keyframes pullRefresh {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes swipeHint {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(-10px); }
        }
        @keyframes levelUp {
          0% { transform: scale(1); }
          25% { transform: scale(1.2); }
          50% { transform: scale(1); }
          75% { transform: scale(1.1); }
          100% { transform: scale(1); }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        .card-animate {
          animation: cardSlideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        .card-animate-1 { animation-delay: 0.05s; opacity: 0; }
        .card-animate-2 { animation-delay: 0.1s; opacity: 0; }
        .card-animate-3 { animation-delay: 0.15s; opacity: 0; }
        .card-animate-4 { animation-delay: 0.2s; opacity: 0; }
        .card-animate-5 { animation-delay: 0.25s; opacity: 0; }
        .screen-enter {
          animation: screenSlideIn 0.3s ease-out forwards;
        }
        .tab-bounce {
          animation: tabBounce 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .reaction-pop {
          animation: reactionPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .toast-animate {
          animation: toastSlideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .modal-backdrop {
          animation: modalBlurIn 0.3s ease-out forwards;
        }
        .modal-content {
          animation: modalSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .btn-press:active {
          animation: buttonPress 0.2s ease-out;
        }
        .progress-animate {
          animation: progressFill 1s ease-out forwards;
          transform-origin: left;
        }
        * {
          box-sizing: border-box;
          -webkit-tap-highlight-color: transparent;
        }
        body {
          margin: 0;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        input:focus, textarea:focus {
          border-color: #0d2847 !important;
          box-shadow: 0 0 0 3px rgba(13,40,71,0.1) !important;
        }
        button {
          transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease, background-color 0.2s ease, opacity 0.2s ease;
        }
        button:active {
          transform: scale(0.94);
        }
        button:hover {
          transform: scale(1.03);
        }
        /* Premium loading shimmer */
        @keyframes loadingShimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .loading-shimmer {
          background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
          background-size: 200% 100%;
          animation: loadingShimmer 1.5s ease-in-out infinite;
        }
        /* Smooth hover lift effect */
        .hover-lift {
          transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease;
        }
        .hover-lift:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 30px rgba(0,0,0,0.15);
        }
        /* Card entrance stagger */
        @keyframes cardEntrance {
          from { opacity: 0; transform: translateY(20px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .card-entrance {
          animation: cardEntrance 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Button press ripple */
        @keyframes buttonRipple {
          0% { transform: scale(0); opacity: 0.6; }
          100% { transform: scale(2.5); opacity: 0; }
        }
        /* Glow pulse for active states */
        @keyframes glowPulse {
          0%, 100% { box-shadow: 0 0 5px rgba(13,40,71,0.2); }
          50% { box-shadow: 0 0 20px rgba(13,40,71,0.4); }
        }
        /* Smooth icon rotation */
        @keyframes iconSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .icon-spin {
          animation: iconSpin 1s linear infinite;
        }
        /* Success checkmark animation */
        @keyframes successCheck {
          0% { transform: scale(0) rotate(-45deg); opacity: 0; }
          50% { transform: scale(1.2) rotate(0deg); opacity: 1; }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        .success-check {
          animation: successCheck 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Slide in from bottom */
        @keyframes slideInBottom {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .slide-in-bottom {
          animation: slideInBottom 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Scale bounce in */
        @keyframes scaleBounceIn {
          0% { transform: scale(0); }
          60% { transform: scale(1.1); }
          100% { transform: scale(1); }
        }
        .scale-bounce-in {
          animation: scaleBounceIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Subtle breathing animation */
        @keyframes breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.02); }
        }
        .breathe {
          animation: breathe 3s ease-in-out infinite;
        }
        /* Enhanced focus states */
        input:focus, textarea:focus, select:focus {
          outline: none;
          border-color: #0d2847 !important;
          box-shadow: 0 0 0 4px rgba(13,40,71,0.1), 0 2px 8px rgba(13,40,71,0.1) !important;
          transition: all 0.2s ease;
        }
        /* Smooth scroll behavior */
        * {
          scroll-behavior: smooth;
        }
        /* Link hover underline animation */
        .link-hover {
          position: relative;
        }
        .link-hover::after {
          content: '';
          position: absolute;
          bottom: -2px;
          left: 0;
          width: 0;
          height: 2px;
          background: #0d2847;
          transition: width 0.3s ease;
        }
        .link-hover:hover::after {
          width: 100%;
        }
        /* Gradient text animation */
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .gradient-text {
          background: linear-gradient(135deg, #0d2847, #2d5a87, #14B8A6, #0d2847);
          background-size: 300% 300%;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: gradientShift 4s ease infinite;
        }
        /* Notification badge bounce */
        @keyframes badgeBounce {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.15); }
        }
        .badge-bounce {
          animation: badgeBounce 0.6s ease-in-out;
        }
        /* Skeleton loading for cards */
        .skeleton {
          background: linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 37%, #f0f0f0 63%);
          background-size: 400% 100%;
          animation: loadingShimmer 1.4s ease infinite;
          border-radius: 8px;
        }
        /* Premium glass effect */
        .glass {
          background: rgba(255,255,255,0.85);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.5);
        }
        /* Interactive card hover */
        .interactive-card {
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .interactive-card:hover {
          transform: translateY(-2px) scale(1.01);
          box-shadow: 0 8px 25px rgba(0,0,0,0.1);
        }
        .interactive-card:active {
          transform: translateY(0) scale(0.99);
        }
        ::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(13,40,71,0.15);
          border-radius: 4px;
          transition: background 0.2s ease;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(13,40,71,0.3);
        }
        /* Smooth scroll containers */
        [style*="overflow"] {
          scroll-behavior: smooth;
          -webkit-overflow-scrolling: touch;
        }
        /* Loading indicator */
        @keyframes loadingPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .loading-pulse {
          animation: loadingPulse 1.5s ease-in-out infinite;
        }
        /* Highlight flash for new items */
        @keyframes highlightFlash {
          0% { background-color: rgba(20,184,166,0.2); }
          100% { background-color: transparent; }
        }
        .highlight-flash {
          animation: highlightFlash 1s ease-out;
        }
        /* Subtle scale on press */
        .press-scale:active {
          transform: scale(0.97);
        }
        /* Gradient border effect */
        .gradient-border {
          position: relative;
          background: white;
        }
        .gradient-border::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 2px;
          background: linear-gradient(135deg, #0d2847, #2d5a87);
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
        }
      `}</style>
    </div>
  );
};

const FlockApp = () => {
  const [authUser, setAuthUser] = useState(null);
  const [authScreen, setAuthScreen] = useState('login');
  const [authChecking, setAuthChecking] = useState(true);

  useEffect(() => {
    if (!isLoggedIn()) {
      setAuthChecking(false);
      return;
    }
    getCurrentUser()
      .then((data) => setAuthUser(data.user || data))
      .catch(() => {
        logout();
        setAuthUser(null);
      })
      .finally(() => setAuthChecking(false));
  }, []);

  if (authChecking) {
    return (
      <div style={{
        minHeight: '100vh',
        background: `linear-gradient(135deg, #0d2847 0%, #1a3a5c 50%, #2d5a87 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#f5f0e6', letterSpacing: '-0.5px', marginBottom: '8px' }}>Flock</div>
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'rgba(245,240,230,0.5)' }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!authUser) {
    if (authScreen === 'signup') {
      return (
        <SignupScreen
          onSignupSuccess={(user) => setAuthUser(user)}
          onSwitchToLogin={() => setAuthScreen('login')}
        />
      );
    }
    return (
      <LoginScreen
        onLoginSuccess={(user) => setAuthUser(user)}
        onSwitchToSignup={() => setAuthScreen('signup')}
      />
    );
  }

  return <FlockAppInner authUser={authUser} onLogout={() => { disconnectSocket(); logout(); setAuthUser(null); setAuthScreen('login'); }} />;
};

export default FlockApp;
