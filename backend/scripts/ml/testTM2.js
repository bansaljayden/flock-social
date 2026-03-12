require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const TM = process.env.TICKETMASTER_API_KEY;

async function test() {
  const params = new URLSearchParams({apikey:TM,keyword:'Rod Stewart',latlong:'40.75,-75.25',radius:50,unit:'miles',size:1,sort:'date,asc'});
  const r = await fetch('https://app.ticketmaster.com/discovery/v2/events.json?'+params);
  const d = await r.json();
  const e = d._embedded?.events?.[0];
  if (!e) { console.log('No events'); return; }

  console.log('=== ALL EVENT IMAGES ===');
  for (const img of (e.images || [])) {
    console.log(`  ${img.width}x${img.height} | ratio:${img.ratio} | fallback:${img.fallback} | ${img.url}`);
  }

  console.log('\n=== ATTRACTION IMAGES ===');
  const a = e._embedded?.attractions?.[0];
  if (a) {
    for (const img of (a.images || [])) {
      console.log(`  ${img.width}x${img.height} | ratio:${img.ratio} | fallback:${img.fallback} | ${img.url}`);
    }
  }
}
test();
