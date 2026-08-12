"""Generate holidays.json — the shared holiday calendar for Starling.

One file consumed by BOTH the Python training pipeline and Node inference
(parity by construction). Three layers:

  holidays       — official public-holiday dates per country calendar
                   (python-holidays pkg), 2025-2028
  party_nights   — original small hand-curated layer (kept for compat)
  special_nights — the 2026-08-12 per-country nightlife research, encoded:
                   every dated night that measurably moves bar/venue demand,
                   with direction (boost / suppress / mixed) and confidence
                   (high / med / low). Scope key is an ISO country code
                   (applies to every training city in that country) or a
                   city key (layered on top; city wins on date collisions).

Direction semantics: "boost" = busier than the same weekday normally is,
"suppress" = quieter (family holiday, exodus, or a LEGAL alcohol/trading
ban — see per-entry names), "mixed" = daypart-dependent (family dinner
kills the evening, clubs spike after midnight). Confidence reflects source
verification in the research doc (RETRAIN.md pointer), not effect size.

Run: python generate_holidays.py   (re-run yearly or when adding cities;
2028 movable religious dates are moon-sighting estimates — refresh them.)
"""
import json
from datetime import date, timedelta
from pathlib import Path

import holidays
from dateutil.easter import easter

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
    'nyc': ('US', 'NY'), 'paris': ('FR', None), 'philly': ('US', 'PA'),
    'rome': ('IT', None),
    'saopaulo': ('BR', 'SP'), 'seattle': ('US', 'WA'), 'seoul': ('KR', None),
    'singapore': ('SG', None), 'sydney': ('AU', 'NSW'), 'toronto': ('CA', 'ON'),
    'miami': ('US', 'FL'), 'tokyo': ('JP', None), 'barcelona': ('ES', 'CT'),
}

# ---------------------------------------------------------------------------
# Movable-date tables (verified in the 2026-08-12 research; 2028 lunar dates
# are astronomical estimates ±1-2 days)
# ---------------------------------------------------------------------------
CNY = {2025: date(2025, 1, 29), 2026: date(2026, 2, 17),
       2027: date(2027, 2, 6), 2028: date(2028, 1, 26)}
SEOLLAL = {2025: date(2025, 1, 29), 2026: date(2026, 2, 17),
           2027: date(2027, 2, 7), 2028: date(2028, 1, 26)}  # KR +1 day in 2027
DIWALI = {2025: date(2025, 10, 20), 2026: date(2026, 11, 8),
          2027: date(2027, 10, 29), 2028: date(2028, 10, 17)}
HOLI = {2025: date(2025, 3, 14), 2026: date(2026, 3, 4),
        2027: date(2027, 3, 22), 2028: date(2028, 3, 11)}
RAMADAN_START = {2025: date(2025, 3, 1), 2026: date(2026, 2, 18),
                 2027: date(2027, 2, 8), 2028: date(2028, 1, 28)}
EID_FITR = {2025: date(2025, 3, 30), 2026: date(2026, 3, 20),
            2027: date(2027, 3, 9), 2028: date(2028, 2, 26)}
EID_ADHA = {2025: date(2025, 6, 6), 2026: date(2026, 5, 27),
            2027: date(2027, 5, 16), 2028: date(2028, 5, 5)}
CHUSEOK_START = {2025: date(2025, 10, 5), 2026: date(2026, 9, 24),
                 2027: date(2027, 9, 14), 2028: date(2028, 10, 2)}  # 3-day holiday
# Thai Buddhist holy days = legal alcohol-sales-ban days (partially relaxed for
# licensed tourist venues since 2025-05-10; ordinary bars still banned)
THAI_BAN = {
    2025: (['02-12', '05-11', '07-10', '07-11', '10-07'], 'high'),
    2026: (['03-03', '05-31', '06-01', '07-29', '07-30', '10-26'], 'high'),
    2027: (['02-21', '05-20', '07-18', '07-19', '10-15'], 'med'),
    2028: (['03-10', '05-08', '07-06', '07-07', '10-02', '10-03'], 'low'),  # unverified est.
}
LOY_KRATHONG = {2025: date(2025, 11, 5), 2026: date(2026, 11, 24), 2027: date(2027, 11, 14)}
# ADE (Amsterdam Dance Event): Wed-Sun, 3rd/4th week Oct. 2025 verified;
# later years estimated from the same pattern.
ADE = {2025: (date(2025, 10, 22), 'high'), 2026: (date(2026, 10, 21), 'med'),
       2027: (date(2027, 10, 20), 'med'), 2028: (date(2028, 10, 18), 'med')}
F1_SINGAPORE = {2025: date(2025, 10, 3)}  # Fri of race weekend; fetch per year


def nth_weekday(year, month, weekday, n):
    """n-th <weekday> of month (Mon=0..Sun=6)."""
    d = date(year, month, 1)
    d += timedelta(days=(weekday - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def last_weekday(year, month, weekday):
    d = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    return d


def weekday_on_or_before(target, weekday):
    d = target
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    return d


def thanksgiving(year):
    return nth_weekday(year, 11, 3, 4)  # 4th Thursday


def party_nights(year):
    """Original small layer, kept as-is for backward compatibility."""
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
    d = date(year, 12, 24)
    while d.weekday() != 4:
        d -= timedelta(days=1)
    nights['GB'][str(d)] = 'mad_friday'
    d = date(year, 12, 1)
    while d <= date(year, 12, 22):
        if d.weekday() == 4:
            nights['JP'][str(d)] = 'bonenkai_friday'
        d += timedelta(days=1)
    return nights


def special_nights():
    """The full research layer. {scope: {date: {name, effect, conf}}}."""
    S = {}

    def add(scope, d, name, effect, conf):
        S.setdefault(scope, {})[str(d)] = {'name': name, 'effect': effect, 'conf': conf}

    def add_range(scope, d1, d2, name, effect, conf):
        d = d1
        while d <= d2:
            add(scope, d, name, effect, conf)
            d += timedelta(days=1)

    for y in YEARS:
        e = easter(y)
        good_friday = e - timedelta(days=2)
        mardi_gras = e - timedelta(days=47)      # Shrove Tuesday
        carnival_fri = e - timedelta(days=51)    # Brazil Carnival opens
        ash_wed = e - timedelta(days=46)
        palm_sunday = e - timedelta(days=7)
        tg = thanksgiving(y)
        nye = date(y, 12, 31)

        # ---- US (all US cities) ----
        add('US', nye, 'nye', 'boost', 'high')
        add('US', tg - timedelta(days=1), 'thanksgiving_eve', 'boost', 'high')
        add('US', date(y, 7, 3), 'july_3', 'boost', 'high')
        add('US', date(y, 7, 4), 'july_4', 'mixed', 'med')
        add('US', date(y, 10, 31), 'halloween', 'boost', 'high')
        add('US', date(y, 3, 17), 'st_patricks', 'boost', 'med')
        add('US', date(y, 5, 5), 'cinco_de_mayo', 'boost', 'med')
        add('US', date(y, 12, 23), 'christmas_eve_eve', 'boost', 'med')
        add('US', last_weekday(y, 5, 0) - timedelta(days=1), 'memorial_sunday', 'boost', 'high')
        add('US', nth_weekday(y, 9, 0, 1) - timedelta(days=1), 'labor_day_sunday', 'boost', 'high')
        add('US', nth_weekday(y, 2, 6, 2), 'super_bowl_sunday', 'mixed', 'med')
        add('US', date(y, 12, 25), 'christmas_day', 'suppress', 'high')
        add('US', tg, 'thanksgiving_day', 'suppress', 'high')
        add('US', e, 'easter_sunday', 'suppress', 'high')
        add('US', date(y, 1, 1), 'new_years_day', 'suppress', 'high')
        # City-specific US
        add_range('nola', carnival_fri, mardi_gras, 'mardi_gras_peak', 'boost', 'high')
        add_range('miami', date(y, 3, 8), date(y, 3, 21), 'spring_break', 'mixed', 'high')
        basel_fri = nth_weekday(y, 12, 4, 1)
        add_range('miami', basel_fri, basel_fri + timedelta(days=1), 'art_basel', 'boost', 'med')
        add_range('austin', date(y, 3, 10), date(y, 3, 19), 'sxsw', 'boost', 'low')
        pride_sun = last_weekday(y, 6, 6)
        for c in ('nyc', 'chicago'):
            add(c, pride_sun - timedelta(days=1), 'pride_saturday', 'boost', 'high')
            add(c, pride_sun, 'pride_sunday', 'boost', 'high')

        # ---- GB / London ----
        mad_fri = weekday_on_or_before(date(y, 12, 24), 4)
        add('GB', mad_fri, 'mad_friday', 'boost', 'high')
        add('GB', nye, 'nye', 'boost', 'high')
        for bank_mon in (nth_weekday(y, 5, 0, 1), last_weekday(y, 5, 0), last_weekday(y, 8, 0)):
            add('GB', bank_mon - timedelta(days=1), 'bank_holiday_sunday', 'boost', 'high')
        aug_mon = last_weekday(y, 8, 0)
        add('GB', aug_mon - timedelta(days=1), 'notting_hill_carnival', 'boost', 'high')
        add('GB', aug_mon, 'notting_hill_carnival', 'boost', 'high')
        add('GB', date(y, 3, 17), 'st_patricks', 'boost', 'med')
        add('GB', date(y, 12, 25), 'christmas_day', 'suppress', 'high')
        add('GB', date(y, 12, 26), 'boxing_day', 'suppress', 'low')

        # ---- ES: Madrid + Barcelona ----
        add('ES', nye, 'nochevieja', 'boost', 'high')
        add('ES', date(y, 12, 24), 'nochebuena', 'mixed', 'med')
        add('barcelona', date(y, 6, 23), 'sant_joan_eve', 'boost', 'high')
        add_range('barcelona', date(y, 9, 20), date(y, 9, 24), 'la_merce', 'boost', 'high')
        add('madrid', date(y, 5, 15), 'san_isidro', 'boost', 'med')

        # ---- FR / Paris ----
        add('FR', date(y, 6, 21), 'fete_de_la_musique', 'boost', 'high')
        add('FR', date(y, 7, 13), 'bastille_eve_bals', 'boost', 'high')
        add('FR', date(y, 7, 14), 'bastille_day', 'boost', 'high')
        add('FR', nye, 'nye', 'boost', 'high')
        for eve in (date(y, 4, 30), date(y, 5, 7), date(y, 8, 14), date(y, 11, 10)):
            add('FR', eve, 'holiday_eve', 'boost', 'med')
        add_range('FR', date(y, 8, 1), date(y, 8, 25), 'august_exodus', 'suppress', 'med')
        add('FR', date(y, 12, 24), 'christmas_eve', 'suppress', 'high')
        add('FR', date(y, 12, 25), 'christmas_day', 'suppress', 'high')

        # ---- IT / Rome ----
        add_range('IT', date(y, 8, 8), date(y, 8, 22), 'ferragosto_exodus', 'suppress', 'high')
        add('IT', nye, 'nye', 'boost', 'high')
        for eve in (date(y, 4, 24), date(y, 6, 1), date(y, 12, 7)):
            add('IT', eve, 'holiday_eve', 'boost', 'med')
        add('IT', date(y, 12, 24), 'christmas_eve', 'suppress', 'high')
        add('IT', date(y, 12, 25), 'christmas_day', 'suppress', 'high')

        # ---- DE / Berlin (Tanzverbot is MILD in Berlin: 04-21h only) ----
        add('DE', date(y, 4, 30), 'walpurgis_night', 'boost', 'high')
        add('DE', date(y, 5, 1), 'may_day_myfest', 'boost', 'high')
        add('DE', nye, 'nye', 'boost', 'high')
        add('DE', date(y, 10, 2), 'unity_day_eve', 'boost', 'med')
        add('DE', date(y, 12, 24), 'christmas_eve', 'suppress', 'high')
        add('berlin', good_friday, 'tanzverbot_karfreitag', 'suppress', 'low')

        # ---- NL / Amsterdam ----
        kings_day = date(y, 4, 27)
        if kings_day.weekday() == 6:  # moved to the 26th when the 27th is a Sunday
            kings_day = date(y, 4, 26)
        add('NL', kings_day - timedelta(days=1), 'kings_night', 'boost', 'high')
        add('NL', kings_day, 'kings_day', 'boost', 'high')
        ade_wed, ade_conf = ADE[y]
        add_range('NL', ade_wed, ade_wed + timedelta(days=4), 'ade', 'boost', ade_conf)
        add('NL', nye, 'nye', 'boost', 'high')
        add('NL', date(y, 5, 4), 'remembrance_eve', 'mixed', 'low')
        add('NL', date(y, 5, 5), 'liberation_day', 'boost', 'med')
        add('NL', nth_weekday(y, 8, 5, 1), 'pride_canal_parade', 'boost', 'med')
        add('NL', date(y, 12, 25), 'christmas_day', 'suppress', 'med')
        add('NL', date(y, 12, 26), 'second_christmas_day', 'suppress', 'med')

        # ---- TH / Bangkok ----
        ban_days, ban_conf = THAI_BAN[y]
        for md in ban_days:
            add('TH', date(y, int(md[:2]), int(md[3:])), 'buddhist_alcohol_ban', 'suppress', ban_conf)
        add_range('TH', date(y, 4, 13), date(y, 4, 15), 'songkran', 'boost', 'high')
        add('TH', nye, 'nye', 'boost', 'high')
        if y in LOY_KRATHONG:
            add('TH', LOY_KRATHONG[y], 'loy_krathong', 'boost', 'med')

        # ---- CN / Beijing ----
        cny = CNY[y]
        add_range('CN', cny - timedelta(days=1), cny + timedelta(days=6), 'cny_exodus', 'suppress', 'high')
        add('CN', date(y, 12, 24), 'pingan_ye', 'boost', 'med')  # couples' date night
        add_range('CN', date(y, 10, 1), date(y, 10, 7), 'golden_week', 'mixed', 'med')
        add('CN', nye, 'nye', 'boost', 'med')

        # ---- SG / Singapore ----
        add('SG', nye, 'nye', 'boost', 'high')
        add('SG', cny - timedelta(days=1), 'cny_eve_reunion', 'mixed', 'med')
        add_range('SG', cny, cny + timedelta(days=1), 'cny_closure', 'suppress', 'high')
        if y in F1_SINGAPORE:
            f1 = F1_SINGAPORE[y]
            add_range('SG', f1, f1 + timedelta(days=2), 'f1_night_race', 'boost', 'high')

        # ---- KR / Seoul (Christmas = couples' night out, OPPOSITE of the West) ----
        add('KR', date(y, 12, 24), 'christmas_eve_couples', 'boost', 'med')
        add('KR', date(y, 12, 25), 'christmas_day_couples', 'boost', 'med')
        seollal = SEOLLAL[y]
        add_range('KR', seollal - timedelta(days=1), seollal + timedelta(days=1), 'seollal', 'suppress', 'high')
        chu = CHUSEOK_START[y]
        add_range('KR', chu, chu + timedelta(days=2), 'chuseok', 'suppress', 'high')
        add('KR', nye, 'nye', 'boost', 'high')
        d = date(y, 12, 1)
        while d <= date(y, 12, 28):
            if d.weekday() == 4:
                add('KR', d, 'hoesik_friday', 'boost', 'med')
            d += timedelta(days=1)
        add('KR', date(y, 10, 31), 'halloween_itaewon', 'mixed', 'med')
        add('KR', date(y, 11, 11), 'pepero_day', 'boost', 'low')

        # ---- JP / Tokyo (NYE is family/shrine — do NOT copy the Western prior) ----
        d = date(y, 12, 1)
        while d <= date(y, 12, 28):
            if d.weekday() == 4:
                add('JP', d, 'bonenkai_friday', 'boost', 'high')
            d += timedelta(days=1)
        add('JP', date(y, 10, 31), 'halloween_shibuya', 'mixed', 'med')
        add('JP', nye, 'nye_shrine', 'mixed', 'med')
        add_range('JP', date(y, 1, 1), date(y, 1, 3), 'shogatsu', 'suppress', 'med')
        add_range('JP', date(y, 8, 13), date(y, 8, 16), 'obon', 'suppress', 'med')
        add_range('JP', date(y, 4, 29), date(y, 5, 5), 'golden_week', 'mixed', 'med')

        # ---- AU / Sydney (NSW restricted trading days are LEGAL bans) ----
        add('AU', nye, 'nye', 'boost', 'high')
        add('AU', date(y, 1, 26), 'australia_day', 'boost', 'high')
        add('AU', date(y, 4, 25), 'anzac_day', 'boost', 'med')
        add('AU', good_friday, 'good_friday_restricted', 'suppress', 'high')
        add('AU', date(y, 12, 25), 'christmas_restricted', 'suppress', 'high')
        add('AU', nth_weekday(y, 11, 1, 1), 'melbourne_cup', 'boost', 'low')

        # ---- CA / Toronto ----
        add('CA', nye, 'nye', 'boost', 'high')
        civic_mon = nth_weekday(y, 8, 0, 1)
        add_range('CA', civic_mon - timedelta(days=2), civic_mon, 'caribana_weekend', 'boost', 'high')
        victoria_mon = weekday_on_or_before(date(y, 5, 24), 0)
        add('CA', victoria_mon - timedelta(days=1), 'victoria_day_sunday', 'boost', 'med')
        add('CA', date(y, 3, 17), 'st_patricks', 'boost', 'high')
        add('CA', date(y, 6, 30), 'canada_day_eve', 'boost', 'med')
        add('CA', nth_weekday(y, 9, 0, 1) - timedelta(days=1), 'labour_day_sunday', 'boost', 'med')
        add('CA', nth_weekday(y, 10, 0, 2) - timedelta(days=1), 'thanksgiving_sunday', 'boost', 'med')
        add('CA', date(y, 12, 25), 'christmas_day', 'suppress', 'high')
        add('CA', good_friday, 'good_friday', 'suppress', 'med')

        # ---- MX / Mexico City ----
        add('MX', date(y, 9, 15), 'grito_night', 'boost', 'high')
        add_range('MX', date(y, 10, 31), date(y, 11, 2), 'dia_de_muertos', 'boost', 'med')
        add('MX', nye, 'nye', 'mixed', 'med')
        add_range('MX', palm_sunday, e, 'semana_santa_exodus', 'suppress', 'med')
        add_range('MX', date(y, 12, 12), date(y, 12, 23), 'posada_season', 'boost', 'med')

        # ---- AR / Buenos Aires ----
        add('AR', date(y, 7, 20), 'dia_del_amigo', 'boost', 'high')
        add('AR', date(y, 9, 21), 'spring_students_day', 'boost', 'med')
        add('AR', date(y, 12, 24), 'nochebuena_late', 'mixed', 'med')
        add('AR', nye, 'nye_late', 'mixed', 'med')
        add('AR', good_friday, 'good_friday', 'suppress', 'low')

        # ---- BR / São Paulo ----
        add_range('BR', carnival_fri, ash_wed, 'carnival', 'boost', 'high')
        for wk in (1, 2):  # esquenta / bloco-rehearsal weekends before Carnival
            sat = carnival_fri - timedelta(days=7 * wk) + timedelta(days=1)
            add('BR', sat, 'pre_carnival_saturday', 'boost', 'med')
            add('BR', sat + timedelta(days=1), 'pre_carnival_sunday', 'boost', 'med')
        add('BR', nye, 'reveillon', 'boost', 'high')
        add('BR', date(y, 6, 12), 'dia_dos_namorados', 'boost', 'high')
        add('BR', date(y, 12, 24), 'christmas_eve', 'suppress', 'med')
        add('BR', date(y, 12, 25), 'christmas_day', 'suppress', 'med')

        # ---- ZA / Cape Town ----
        add_range('ZA', date(y, 12, 15), date(y, 12, 31), 'festive_season', 'boost', 'high')
        add_range('ZA', date(y, 1, 1), date(y, 1, 5), 'festive_season', 'boost', 'high')
        add('ZA', date(y, 1, 2), 'tweede_nuwe_jaar', 'boost', 'high')
        add('ZA', nye, 'nye', 'boost', 'high')
        add('ZA', good_friday, 'good_friday', 'suppress', 'med')
        add('ZA', date(y, 12, 25), 'christmas_day', 'suppress', 'med')

        # ---- IN / Delhi + Mumbai (national dry days = LEGAL alcohol bans) ----
        for md, nm in ((date(y, 1, 26), 'dry_day_republic'), (date(y, 8, 15), 'dry_day_independence'),
                       (date(y, 10, 2), 'dry_day_gandhi_jayanti')):
            add('IN', md, nm, 'suppress', 'high')
        add('IN', nye, 'nye', 'boost', 'high')
        add('IN', DIWALI[y], 'diwali', 'mixed', 'med')
        add('IN', HOLI[y], 'holi', 'mixed', 'med')
        # Maharashtra observes extra dry days (Mumbai only)
        add('mumbai', date(y, 4, 14), 'dry_day_ambedkar', 'suppress', 'high')
        add('mumbai', date(y, 1, 30), 'dry_day_martyrs', 'suppress', 'med')
        add('mumbai', HOLI[y], 'holi_dry_day', 'suppress', 'med')

        # ---- AE / Dubai (Ramadan is liberalized since 2021: mild suppress only) ----
        add_range('AE', RAMADAN_START[y], EID_FITR[y] - timedelta(days=1), 'ramadan', 'suppress', 'med')
        add_range('AE', EID_FITR[y], EID_FITR[y] + timedelta(days=2), 'eid_al_fitr', 'boost', 'med')
        add_range('AE', EID_ADHA[y], EID_ADHA[y] + timedelta(days=2), 'eid_al_adha', 'boost', 'med')
        add('AE', nye, 'nye', 'boost', 'high')

    return S


def main():
    out = {'generated_for_years': YEARS, 'cities': {}, 'holidays': {},
           'party_nights': {}, 'special_nights': special_nights()}
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
    s = sum(len(v) for v in out['special_nights'].values())
    print(f'holidays.json: {len(out["holidays"])} calendars, {n} holiday dates, '
          f'{p} party nights, {s} special nights across {len(out["special_nights"])} scopes -> {dest}')


if __name__ == '__main__':
    main()
