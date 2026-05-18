import { useEffect, useState, useCallback } from 'react';
import { Platform, PermissionsAndroid, Alert } from 'react-native';
import Geolocation from '@react-native-community/geolocation';

// Get-once + refresh helper. Doesn't watch continuously (the map's "my
// location" tracking is handled by react-native-maps directly via the
// `showsUserLocation` prop). This hook just gives us a numeric lat/lng to
// center the map on at boot.

const FALLBACK = { latitude: 40.7128, longitude: -74.006 }; // NYC

async function ensureAndroidPermission() {
  if (Platform.OS !== 'android') return true;
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Location permission',
        message: 'Flock uses your location to show nearby spots and crowd predictions.',
        buttonPositive: 'OK',
        buttonNegative: 'Cancel',
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export function useLocation() {
  const [location, setLocation] = useState(null); // { latitude, longitude, accuracy }
  const [permission, setPermission] = useState(null); // 'granted' | 'denied' | null
  const [loading, setLoading] = useState(true);

  const fetchOnce = useCallback(async () => {
    setLoading(true);
    const ok = await ensureAndroidPermission();
    if (!ok) {
      setPermission('denied');
      setLocation(FALLBACK);
      setLoading(false);
      return FALLBACK;
    }
    setPermission('granted');
    return new Promise((resolve) => {
      Geolocation.getCurrentPosition(
        (pos) => {
          const next = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
          setLocation(next);
          setLoading(false);
          resolve(next);
        },
        (err) => {
          console.warn('Geolocation error:', err.message);
          setLocation(FALLBACK);
          setLoading(false);
          resolve(FALLBACK);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    });
  }, []);

  useEffect(() => { fetchOnce(); }, [fetchOnce]);

  return { location, permission, loading, refresh: fetchOnce };
}
