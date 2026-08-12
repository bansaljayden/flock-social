"""Generate holidays.json — the shared holiday calendar for Starling.

One file consumed by BOTH the Python training pipeline and Node inference
(parity by construction). Covers every training-city country 2025-2028 plus a
hand-curated party-nights layer (the eves and named nights that actually move
bar demand — see RETRAIN.md research: the EVE beats the day for nightlife).

Run: python generate_holidays.py   (re-run yearly or when adding cities)
"""
import json
from datetime import date, timedelta
from pathlib import Path

import holidays

YEARS = [2025, 2026, 2027, 2028]

# Training cities → country (+ subdivision where holidays differ regionally)
CITY_COUNTRY = {
    'amsterdam': ('NL', None), 'austin': ('US', 'TX'), 'bangkok': ('TH', None),
    'beijing': ('CN', None), 'berlin': ('DE', 'BE'), 'boston': ('US', 'MA'),
    'buenosaires': ('AR', None), 'capetown': ('ZA', None), 'chicago': ('US', 'IL'),
    'dallas': ('US', 'TX'), 'delhi': ('IN', None), 'denver': ('US', 'CO'),
    'dubai': ('AE', None), 'la': ('US', 'CA'), 'lehigh': ('US', 'PA'),
    'london': ('GB', 'ENG'), 'madrid': ('ES', 'MD'), 'mexico': ('MX', None),
    'mumbai': ('IN', None), 'nashville': ('US', 'TN'), 'nola': ('US', 'LA'),
    'nyc': ('US', 'NY'), 'paris': ('FR', None), 'rome': ('IT', None),
    'saopaulo': ('BR', 'SP'), 'seattle': ('US', 'WA'), 'seoul': ('KR', None),
    'singapore': ('SG', None), 'sydney': ('AU', 'NSW'), 'toronto': ('CA', 'ON'),
    'miami': ('US', 'FL'), 'tokyo': ('JP', None), 'barcelona': ('ES', 'CT'),
}


def thanksgiving(year):
    """4th Thursday of November (US)."""
    d = date(year, 11, 1)
    d += timedelta(days=(3 - d.weekday()) % 7)  # first Thursday
    return d + timedelta(weeks=3)


def party_nights(year):
    """Named nights with documented outsized bar demand (see RETRAIN.md).
    Country-scoped; 'US' entries apply to US cities, etc."""
    tg = thanksgiving(year)
    nights = {
        'US': {
            str(date(year, 12, 31)): 'nye',
            str(tg - timedelta(days=1)): 'thanksgiving_eve',
            str(date(year, 7, 3)): 'july_3',
            str(date(year, 10, 31)): 'halloween',
            str(date(year, 3, 17)): 'st_patricks',
            str(date(year, 5, 5)): 'cinco_de_mayo',
        },
        'GB': {str(date(year, 12, 31)): 'nye'},
        'ES': {str(date(year, 12, 31)): 'nochevieja', str(date(year, 6, 23)): 'san_juan'},
        'JP': {},  # NYE in Japan is family/shrine-oriented — deliberately NOT a party night
    }
    # UK Mad Friday: last Friday before Christmas
    d = date(year, 12, 24)
    while d.weekday() != 4:
        d -= timedelta(days=1)
    nights['GB'][str(d)] = 'mad_friday'
    # Japan bonenkai: Fridays Dec 1-22
    d = date(year, 12, 1)
    while d <= date(year, 12, 22):
        if d.weekday() == 4:
            nights['JP'][str(d)] = 'bonenkai_friday'
        d += timedelta(days=1)
    return nights


def main():
    out = {'generated_for_years': YEARS, 'cities': {}, 'holidays': {}, 'party_nights': {}}
    seen = {}
    for city, (country, subdiv) in CITY_COUNTRY.items():
        key = f'{country}_{subdiv or ""}'
        out['cities'][city] = key
        if key in seen:
            continue
        seen[key] = True
        cal = holidays.country_holidays(country, subdiv=subdiv, years=YEARS)
        out['holidays'][key] = sorted(str(d) for d in cal)
    for y in YEARS:
        for country, nights in party_nights(y).items():
            out['party_nights'].setdefault(country, {}).update(nights)

    dest = Path(__file__).parent / 'holidays.json'
    dest.write_text(json.dumps(out, indent=1), encoding='utf-8')
    n = sum(len(v) for v in out['holidays'].values())
    p = sum(len(v) for v in out['party_nights'].values())
    print(f'holidays.json: {len(out["holidays"])} calendars, {n} holiday dates, {p} party nights -> {dest}')


if __name__ == '__main__':
    main()
