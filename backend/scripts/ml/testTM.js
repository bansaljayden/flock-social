require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const TM = process.env.TICKETMASTER_API_KEY;

async function test() {
  const params = new URLSearchParams({apikey:TM,keyword:'Rod Stewart',latlong:'40.75,-75.25',radius:50,unit:'miles',size:1,sort:'date,asc'});
  const r = await fetch('https://app.ticketmaster.com/discovery/v2/events.json?'+params);
  const d = await r.json();
  const e = d._embedded?.events?.[0];
  if (!e) { console.log('No events'); return; }
  console.log('NAME:', e.name);
  console.log('URL:', e.url);
  console.log('INFO:', e.info?.substring(0,300));
  console.log('PLEASE NOTE:', e.pleaseNote?.substring(0,200));
  console.log('SEATMAP:', JSON.stringify(e.seatmap));
  console.log('PRICE:', JSON.stringify(e.priceRanges));
  console.log('CLASSIFICATIONS:', JSON.stringify(e.classifications?.[0], null, 2));
  console.log('IMAGES total:', e.images?.length);
  console.log('Non-fallback:', e.images?.filter(i => !i.fallback).length);
  const best = e.images?.find(i => !i.fallback && i.ratio === '16_9' && i.width >= 500) || e.images?.find(i => i.ratio === '16_9' && i.width >= 500);
  console.log('BEST IMAGE:', best?.url, '| fallback:', best?.fallback);
  // Check attractions for real images
  const attractions = e._embedded?.attractions || [];
  for (const a of attractions) {
    const realImgs = (a.images || []).filter(i => !i.fallback);
    console.log('ATTRACTION:', a.name, '| real images:', realImgs.length);
    if (realImgs[0]) console.log('  Best:', realImgs.find(i => i.ratio === '16_9')?.url || realImgs[0].url);
  }
}
test();
