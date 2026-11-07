// WHICH RESULTS THE DISCOVER MAP FRAMES.
//
// clusterPoints is the map's long-standing rule for a new result set: fit to
// the cluster around the median point, so one result on the other side of the
// country does not zoom the map out to the continent. framePoints adds the
// rule for a COMMITTED search (Return in the search box, See all, the count
// chip): the results within 25 km of the person, when there are any, so a
// search that found the place down the road and a namesake 125 km away frames
// the one down the road, and a map left zoomed on one pin shows the rest
// again. With none that close, the cluster rule.
//
// Points are [lng, lat]. Distances are the flat-earth approximation the map
// already used; at 25 km it is well under a percent off.

export const COMMITTED_FIT_RADIUS_KM = 25;

const kmApart = ([lng1, lat1], [lng2, lat2]) => Math.hypot(
  (lng1 - lng2) * 111 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180),
  (lat1 - lat2) * 111,
);

export const clusterPoints = (points) => {
  if (!Array.isArray(points) || points.length === 0) return [];
  const sortedLng = points.map((p) => p[0]).slice().sort((a, b) => a - b);
  const sortedLat = points.map((p) => p[1]).slice().sort((a, b) => a - b);
  const mid = [sortedLng[sortedLng.length >> 1], sortedLat[sortedLat.length >> 1]];
  const sortedDist = points.map((p) => kmApart(p, mid)).sort((a, b) => a - b);
  const medianDist = sortedDist[sortedDist.length >> 1] || 0;
  const limitKm = Math.max(15, medianDist * 4);
  const core = points.filter((p) => kmApart(p, mid) <= limitKm);
  return core.length < 2 ? points : core;
};

export const framePoints = (points, { center = null, radiusKm = COMMITTED_FIT_RADIUS_KM } = {}) => {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (Array.isArray(center) && center.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const near = points.filter((p) => kmApart(p, center) <= radiusKm);
    if (near.length > 0) return near;
  }
  return clusterPoints(points);
};
