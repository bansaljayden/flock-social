import React from 'react';
import { View, Image, StyleSheet, Platform } from 'react-native';
import { Marker } from 'react-native-maps';
import { useTheme } from '../../context/ThemeContext';

// Replacement for the canvas-based circular photo pins from the web app
// (App.js:353–381 — `buildPhotoPin` + `toDataURL`). RN approach:
//   - <Marker> at the venue's lat/lng
//   - Inside, a colored ring <View> + <Image> centered with overflow:hidden
// No canvas. No data URLs. The colored ring encodes crowd score; this
// replaces the heatmap layer (skipped on RN per the spec).

const ringColorForCrowd = (crowd, palette) => {
  if (crowd > 70) return palette.red;
  if (crowd > 40) return palette.amber;
  return palette.teal;
};

const ringColorForCategory = (category, palette) => {
  switch (category) {
    case 'Food': return palette.food;
    case 'Nightlife': return palette.nightlife;
    case 'Live Music': return palette.music;
    case 'Sports': return palette.sports;
    default: return palette.teal;
  }
};

export default function VenueMarker({
  venue,
  isActive = false,
  onPress,
  size,
  // 'crowd' encodes color by busyness (default), 'category' by venue type.
  ringMode = 'crowd',
}) {
  const { colors } = useTheme();
  const lat = venue?.location?.latitude || venue?.lat;
  const lng = venue?.location?.longitude || venue?.lng;
  if (!lat || !lng) return null;

  const dim = size ?? (isActive ? 52 : 40);
  const ringColor = ringMode === 'crowd'
    ? ringColorForCrowd(venue?.crowd ?? venue?.score ?? 0, colors)
    : ringColorForCategory(venue?.category, colors);

  const photoUrl = venue?.photo_url || null;

  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lng }}
      onPress={onPress}
      // anchor: center the marker on the coord (default is bottom-center)
      anchor={{ x: 0.5, y: 0.5 }}
      // tracksViewChanges only when active or photo loading — perf win on
      // long lists. iOS ignores this beyond initial layout.
      tracksViewChanges={isActive}
    >
      <View
        style={[
          styles.ring,
          {
            width: dim,
            height: dim,
            borderRadius: dim / 2,
            borderColor: ringColor,
            backgroundColor: colors.bgCardSolid,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.25,
            shadowRadius: 4,
            elevation: 3,
          },
        ]}
      >
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={[styles.photo, { width: dim - 6, height: dim - 6, borderRadius: (dim - 6) / 2 }]} />
        ) : (
          <View
            style={[
              styles.photo,
              {
                width: dim - 6,
                height: dim - 6,
                borderRadius: (dim - 6) / 2,
                backgroundColor: ringColor,
              },
            ]}
          />
        )}
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  ring: {
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photo: { resizeMode: 'cover' },
});
