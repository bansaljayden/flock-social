import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
  FlatList,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { PROVIDER_GOOGLE, PROVIDER_DEFAULT } from 'react-native-maps';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useLocation } from '../../hooks/useLocation';
import VenueMarker from '../../components/venue/VenueMarker';
import VenueDetailModal from './VenueDetailModal';
import { searchVenues, getCrowdBatch } from '../../services/api';
import { track, Events } from '../../services/posthog';
import { cardShadow } from '../../theme/shadows';

// Phase 3 DiscoverScreen — react-native-maps replacing MapLibre GL JS.
//
// Architecture (matches the spec but adapted for RN-maps' constraints):
//   - Map renders with user location dot (showsUserLocation)
//   - Search bar at top → debounced searchVenues call
//   - Results render as a FlatList overlay AND as VenueMarker pins on the map
//   - Tap a marker or list row → VenueDetailModal slides up
//   - Crowd-batch fetched after search results land, used to color the markers
//
// What's intentionally not here (deferred to a polish pass):
//   - Marker clustering (use react-native-map-clustering when density warrants)
//   - Heatmap (no good RN equivalent — marker color encodes crowd)
//   - Flock member location markers
//   - Sort/filter pill row
//   - Custom map style JSON (Apple Maps/Google's defaults look fine for v1)

export default function DiscoverScreen() {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { location, loading: locLoading } = useLocation();
  const mapRef = useRef(null);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [venues, setVenues] = useState([]);
  const [activeVenue, setActiveVenue] = useState(null);
  const [showResults, setShowResults] = useState(false);

  const searchTimerRef = useRef(null);

  // Recenter map on location once geolocation resolves
  useEffect(() => {
    if (!location || !mapRef.current) return;
    mapRef.current.animateToRegion({
      latitude: location.latitude,
      longitude: location.longitude,
      latitudeDelta: 0.04,
      longitudeDelta: 0.04,
    }, 600);
  }, [location?.latitude, location?.longitude]);

  // Debounced search — same UX as the web's venue search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!query.trim()) { setVenues([]); setShowResults(false); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const locParam = location ? `${location.latitude},${location.longitude}` : '';
        const data = await searchVenues(query.trim(), locParam);
        const list = data?.venues || [];
        setVenues(list);
        setShowResults(true);
        track(Events.VenueSearched, { query: query.trim().slice(0, 60), result_count: list.length });

        // Best-effort crowd batch — color the markers + sort by score later.
        // Failures are silent; markers fall back to default ring color.
        if (list.length > 0) {
          getCrowdBatch(list.slice(0, 12).map(v => ({ place_id: v.place_id, types: v.types })))
            .then(({ predictions }) => {
              if (!predictions) return;
              setVenues(prev => prev.map(v => {
                const p = predictions.find(x => x.placeId === v.place_id);
                return p ? { ...v, crowd: p.score, crowdLabel: p.label } : v;
              }));
            })
            .catch(() => {});
        }
      } catch (e) {
        console.warn('Search failed:', e.message);
      } finally {
        setSearching(false);
      }
    }, 280);

    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [query, location]);

  const recenterOnUser = useCallback(() => {
    if (!location || !mapRef.current) return;
    mapRef.current.animateToRegion({
      latitude: location.latitude,
      longitude: location.longitude,
      latitudeDelta: 0.04,
      longitudeDelta: 0.04,
    }, 400);
  }, [location]);

  const handleVenuePress = (venue) => {
    setActiveVenue(venue);
    // Pan map to the venue
    const lat = venue?.location?.latitude || venue?.lat;
    const lng = venue?.location?.longitude || venue?.lng;
    if (lat && lng && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: lat, longitude: lng, latitudeDelta: 0.012, longitudeDelta: 0.012,
      }, 350);
    }
    setShowResults(false);
  };

  const renderResultItem = ({ item }) => (
    <TouchableOpacity
      onPress={() => handleVenuePress(item)}
      style={[styles.resultRow, { borderBottomColor: colors.borderSubtle }]}
    >
      {item.photo_url ? (
        <Image source={{ uri: item.photo_url }} style={styles.resultPhoto} />
      ) : (
        <View style={[styles.resultPhoto, { backgroundColor: colors.iconBg, alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name="map-pin" size={18} color={colors.textTertiary} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={[typography.bodyBold, { color: colors.textPrimary }]} numberOfLines={1}>{item.name}</Text>
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]} numberOfLines={1}>
          {item.formatted_address || item.addr || (item.types || []).slice(0, 2).join(' · ')}
        </Text>
      </View>
      {Number.isFinite(item.crowd) && (
        <View style={[styles.crowdPill, {
          backgroundColor:
            item.crowd > 70 ? colors.accentRedBg
            : item.crowd > 40 ? colors.accentAmberBg
            : colors.accentGreenBg,
          borderRadius: radius.lg,
        }]}>
          <Text style={[typography.label, {
            letterSpacing: 0,
            color: item.crowd > 70 ? colors.accentRedText : item.crowd > 40 ? colors.accentAmberText : colors.accentGreenText,
          }]}>
            {item.crowdLabel || `${item.crowd}%`}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );

  // Apple Maps on iOS by default; Google Maps on Android (requires API key
  // configured natively — in /android/app/src/main/AndroidManifest.xml).
  const mapProvider = Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <MapView
        ref={mapRef}
        provider={mapProvider}
        style={StyleSheet.absoluteFill}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        initialRegion={{
          latitude: location?.latitude || 40.7128,
          longitude: location?.longitude || -74.006,
          latitudeDelta: 0.04,
          longitudeDelta: 0.04,
        }}
      >
        {venues.map((v) => (
          <VenueMarker
            key={v.place_id}
            venue={v}
            isActive={activeVenue?.place_id === v.place_id}
            onPress={() => handleVenuePress(v)}
          />
        ))}
      </MapView>

      {/* Search bar */}
      <View style={[styles.searchContainer, { paddingHorizontal: screenPadding.default }]}>
        <View style={[
          styles.searchBar,
          {
            backgroundColor: colors.bgCardSolid,
            borderColor: colors.borderDefault,
            borderRadius: radius.pill,
            ...cardShadow(colors),
          },
        ]}>
          <Icon name="search" size={18} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search venues nearby"
            placeholderTextColor={colors.textTertiary}
            style={[styles.searchInput, typography.body, { color: colors.textPrimary }]}
            autoCorrect={false}
            returnKeyType="search"
            onFocus={() => setShowResults(venues.length > 0)}
          />
          {searching ? (
            <ActivityIndicator size="small" color={colors.teal} />
          ) : query ? (
            <TouchableOpacity onPress={() => { setQuery(''); setVenues([]); setShowResults(false); }}>
              <Icon name="x" size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Results overlay */}
      {showResults && venues.length > 0 && (
        <View style={[
          styles.resultsList,
          {
            backgroundColor: colors.bgCardSolid,
            borderColor: colors.borderDefault,
            borderRadius: radius.xxl,
            marginHorizontal: screenPadding.default,
            ...cardShadow(colors),
          },
        ]}>
          <FlatList
            data={venues.slice(0, 8)}
            keyExtractor={(item) => item.place_id}
            renderItem={renderResultItem}
            keyboardShouldPersistTaps="handled"
          />
        </View>
      )}

      {/* My-location button */}
      <TouchableOpacity
        onPress={recenterOnUser}
        disabled={locLoading}
        style={[
          styles.locationBtn,
          {
            backgroundColor: colors.bgCardSolid,
            borderColor: colors.borderDefault,
            ...cardShadow(colors),
          },
        ]}
      >
        <Icon name="navigation" size={18} color={colors.teal} />
      </TouchableOpacity>

      <VenueDetailModal
        visible={!!activeVenue}
        venue={activeVenue}
        onClose={() => setActiveVenue(null)}
        onSelectAlternative={(alt) => {
          // Treat the alternative as a normal venue selection
          setActiveVenue(null);
          setTimeout(() => handleVenuePress({ ...alt, place_id: alt.placeId || alt.place_id }), 220);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchContainer: { position: 'absolute', top: 8, left: 0, right: 0, zIndex: 10 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    borderWidth: 1,
  },
  searchInput: { flex: 1, padding: 0 },
  resultsList: {
    position: 'absolute',
    top: 64,
    left: 0,
    right: 0,
    maxHeight: 360,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 9,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  resultPhoto: { width: 40, height: 40, borderRadius: 10 },
  crowdPill: { paddingHorizontal: 8, paddingVertical: 3 },
  locationBtn: {
    position: 'absolute',
    bottom: 96,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
