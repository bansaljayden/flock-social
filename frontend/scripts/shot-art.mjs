/**
 * shot-art.mjs: the venue pictures in screenshots, drawn here.
 *
 * WHY THE RIG DOES NOT SHOW VENUE PHOTOS. The capture rig drives the real app,
 * and the real app shows each venue's Google Places photo. Those photos are
 * other people's copyrighted work (backend/services/photoStore.js records that
 * the Maps terms do not even allow caching their bytes), and they show real
 * people, bars and drinks. App Store screenshots must suit a 4+ audience
 * (Guideline 2.3.8) whatever the app's own rating, and every capture here is
 * redistributed in the listing and on the marketing site. So the rig answers
 * every venue-photo request with one of the illustrations below instead. Each
 * one is drawn in this file: plain shapes, food and rooms, no people, no drinks.
 *
 * HOW. installVenueArt() routes /api/venues/photo (the backend's photo proxy,
 * which is where every venue image in the app comes from) to these pictures,
 * before the request leaves the browser. The rest of each screen is untouched:
 * real UI, real data, real rendering. A side effect worth having: a capture
 * run no longer spends Places photo quota at all.
 *
 * The seeded demo venue (The Copper Finch) points its photo at the same proxy
 * with the ref "shots-copper-finch", so it gets the dining room; its three
 * further photos (counter, stage, wings) and its logo (the burger) are pinned
 * the same way. A ref of the form "shots-art-<id>" names its own drawing,
 * which is how the site story's invented places (capture-screenshots.mjs,
 * SITE_VENUES) each keep one picture.
 */

const W = 400;
const H = 300;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;

/* Fourteen pictures. Each keeps its subject in the middle, because the map
   crops a venue photo to a small circle around the centre. */
export const VENUE_ART = [
  {
    id: 'burger',
    svg: svg(`
      <rect width="400" height="300" fill="#22324a"/>
      <g fill="#2b3f5d">
        <path d="M200 150 L-40 60 L-40 110 Z"/><path d="M200 150 L-40 200 L-40 250 Z"/>
        <path d="M200 150 L440 60 L440 110 Z"/><path d="M200 150 L440 200 L440 250 Z"/>
        <path d="M200 150 L120 -20 L180 -20 Z"/><path d="M200 150 L220 -20 L280 -20 Z"/>
      </g>
      <ellipse cx="200" cy="246" rx="128" ry="16" fill="#18253a"/>
      <rect x="104" y="206" width="192" height="34" rx="16" fill="#e0a052"/>
      <rect x="96" y="178" width="208" height="34" rx="17" fill="#6b3a21"/>
      <path d="M100 182 L300 182 L292 196 L276 186 L262 204 L246 188 L226 200 L206 186 L188 202 L170 188 L150 200 L132 186 L114 198 Z" fill="#f6c343"/>
      <rect x="110" y="164" width="180" height="16" rx="8" fill="#d94a3d"/>
      <path d="M100 162 Q112 148 124 162 Q136 148 148 162 Q160 148 172 162 Q184 148 196 162 Q208 148 220 162 Q232 148 244 162 Q256 148 268 162 Q280 148 292 162 Q300 152 304 160 L304 168 L96 168 Z" fill="#74b84b"/>
      <path d="M100 154 Q200 34 300 154 Z" fill="#e8a24f"/>
      <path d="M128 132 Q200 62 272 132" fill="none" stroke="#f0b866" stroke-width="6" stroke-linecap="round" opacity="0.7"/>
      <g fill="#fdf3dc">
        <ellipse cx="170" cy="104" rx="6" ry="3" transform="rotate(-20 170 104)"/>
        <ellipse cx="200" cy="92" rx="6" ry="3"/>
        <ellipse cx="232" cy="104" rx="6" ry="3" transform="rotate(20 232 104)"/>
        <ellipse cx="150" cy="128" rx="6" ry="3" transform="rotate(-30 150 128)"/>
        <ellipse cx="190" cy="118" rx="6" ry="3" transform="rotate(-10 190 118)"/>
        <ellipse cx="220" cy="124" rx="6" ry="3" transform="rotate(15 220 124)"/>
        <ellipse cx="252" cy="128" rx="6" ry="3" transform="rotate(30 252 128)"/>
      </g>`),
  },
  {
    id: 'pizza',
    svg: svg(`
      <rect width="400" height="300" fill="#b9814f"/>
      <g fill="none" stroke="#a7703f" stroke-width="4" opacity="0.7">
        <path d="M0 36 C120 26 280 50 400 34"/><path d="M0 118 C140 108 260 132 400 112"/>
        <path d="M0 204 C120 194 300 218 400 200"/><path d="M0 278 C150 268 250 288 400 272"/>
      </g>
      <circle cx="200" cy="150" r="124" fill="#e3ab5c"/>
      <circle cx="200" cy="150" r="104" fill="#cf4b36"/>
      <g fill="#f5d98b">
        <path d="M150 90 q20 -14 36 4 q14 18 -8 26 q-26 8 -28 -30 z"/>
        <path d="M232 92 q26 -6 30 18 q2 22 -22 18 q-20 -4 -8 -36 z"/>
        <path d="M120 150 q10 -24 34 -12 q18 14 2 32 q-22 14 -36 -20 z"/>
        <path d="M238 160 q22 -16 38 2 q10 22 -12 28 q-30 6 -26 -30 z"/>
        <path d="M168 196 q18 -18 38 0 q12 20 -12 26 q-28 4 -26 -26 z"/>
        <path d="M186 138 q14 -12 28 2 q8 14 -8 20 q-24 2 -20 -22 z"/>
      </g>
      <g fill="#a8322a">
        <circle cx="176" cy="122" r="15"/><circle cx="246" cy="132" r="15"/><circle cx="146" cy="186" r="15"/>
        <circle cx="222" cy="200" r="15"/><circle cx="272" cy="186" r="13"/><circle cx="200" cy="80" r="13"/>
      </g>
      <g fill="#c4473b" opacity="0.8">
        <circle cx="172" cy="118" r="3"/><circle cx="250" cy="128" r="3"/><circle cx="142" cy="182" r="3"/><circle cx="226" cy="196" r="3"/>
      </g>
      <g fill="#4f8a3e">
        <ellipse cx="208" cy="160" rx="12" ry="6" transform="rotate(30 208 160)"/>
        <ellipse cx="124" cy="132" rx="11" ry="5" transform="rotate(-40 124 132)"/>
        <ellipse cx="270" cy="102" rx="11" ry="5" transform="rotate(20 270 102)"/>
      </g>
      <g stroke="#f0c27a" stroke-width="4" stroke-linecap="round">
        <line x1="200" y1="150" x2="200" y2="30"/><line x1="200" y1="150" x2="304" y2="210"/><line x1="200" y1="150" x2="96" y2="210"/>
      </g>`),
  },
  {
    id: 'tacos',
    svg: svg(`
      <rect width="400" height="300" fill="#2f8f8a"/>
      <g fill="#3aa29c"><circle cx="40" cy="40" r="6"/><circle cx="360" cy="50" r="6"/><circle cx="60" cy="250" r="6"/><circle cx="350" cy="260" r="6"/><circle cx="200" cy="30" r="5"/></g>
      <ellipse cx="200" cy="214" rx="176" ry="58" fill="#f4ead6"/>
      <ellipse cx="200" cy="208" rx="160" ry="48" fill="#ece0c8"/>
      <g>
        <path d="M66 172 q10 -22 26 -8 q12 -22 28 -4 q14 -18 26 6 l0 8 l-80 0 z" fill="#6aa84f"/>
        <path d="M70 176 q36 -16 72 0 l0 6 l-72 0 z" fill="#7a4a2a"/>
        <circle cx="86" cy="168" r="5" fill="#d9473b"/><circle cx="118" cy="164" r="5" fill="#d9473b"/>
        <path d="M58 180 A 50 50 0 0 0 154 180 Z" fill="#e9b850" stroke="#c9902f" stroke-width="4"/>
      </g>
      <g>
        <path d="M156 160 q10 -22 26 -8 q12 -22 28 -4 q14 -18 26 6 l0 8 l-80 0 z" fill="#6aa84f"/>
        <path d="M160 164 q36 -16 72 0 l0 6 l-72 0 z" fill="#7a4a2a"/>
        <circle cx="176" cy="156" r="5" fill="#d9473b"/><circle cx="210" cy="150" r="5" fill="#d9473b"/>
        <path d="M184 154 l10 -6 M198 156 l8 -8" stroke="#f2c94c" stroke-width="4" stroke-linecap="round"/>
        <path d="M148 168 A 50 50 0 0 0 244 168 Z" fill="#e9b850" stroke="#c9902f" stroke-width="4"/>
      </g>
      <g>
        <path d="M246 172 q10 -22 26 -8 q12 -22 28 -4 q14 -18 26 6 l0 8 l-80 0 z" fill="#6aa84f"/>
        <path d="M250 176 q36 -16 72 0 l0 6 l-72 0 z" fill="#7a4a2a"/>
        <circle cx="266" cy="168" r="5" fill="#d9473b"/><circle cx="300" cy="162" r="5" fill="#d9473b"/>
        <path d="M238 180 A 50 50 0 0 0 334 180 Z" fill="#e9b850" stroke="#c9902f" stroke-width="4"/>
      </g>
      <g fill="#7ab55c"><path d="M180 248 q8 -14 16 0 q-8 6 -16 0 z"/><path d="M212 250 q8 -14 16 0 q-8 6 -16 0 z"/></g>`),
  },
  {
    id: 'noodles',
    svg: svg(`
      <rect width="400" height="300" fill="#d6573f"/>
      <g fill="#df6b54"><circle cx="50" cy="60" r="18"/><circle cx="350" cy="240" r="22"/><circle cx="330" cy="50" r="10"/><circle cx="70" cy="250" r="12"/></g>
      <ellipse cx="200" cy="262" rx="120" ry="14" fill="#b8462f"/>
      <path d="M66 140 Q72 262 200 262 Q328 262 334 140 Z" fill="#fdf7ec"/>
      <path d="M96 196 Q200 228 304 196" fill="none" stroke="#1f3048" stroke-width="6"/>
      <ellipse cx="200" cy="140" rx="134" ry="30" fill="#1f3048"/>
      <ellipse cx="200" cy="140" rx="122" ry="23" fill="#e9c46a"/>
      <g fill="none" stroke="#f7e6ad" stroke-width="5" stroke-linecap="round">
        <path d="M96 140 q14 -10 28 0 q14 10 28 0 q14 -10 28 0"/>
        <path d="M150 128 q14 -8 28 0 q14 8 28 0 q14 -8 28 0"/>
        <path d="M170 150 q14 -8 28 0 q14 8 28 0 q14 -8 28 0"/>
      </g>
      <ellipse cx="252" cy="134" rx="24" ry="14" fill="#fffdf6"/>
      <circle cx="252" cy="134" r="8" fill="#f2a516"/>
      <g fill="#6ab04c"><circle cx="128" cy="150" r="5"/><circle cx="140" cy="132" r="4"/><circle cx="296" cy="146" r="5"/><circle cx="214" cy="124" r="4"/></g>
      <g stroke="#8b5a2b" stroke-width="9" stroke-linecap="round">
        <line x1="236" y1="44" x2="356" y2="150"/><line x1="262" y1="30" x2="374" y2="134"/>
      </g>`),
  },
  {
    id: 'bakery',
    svg: svg(`
      <rect width="400" height="300" fill="#f3e6cf"/>
      <rect x="0" y="0" width="400" height="300" fill="#efdfc2" opacity="0.6"/>
      <rect x="20" y="132" width="360" height="12" rx="4" fill="#8a5a3b"/>
      <rect x="20" y="252" width="360" height="12" rx="4" fill="#8a5a3b"/>
      <g fill="#d9963f" stroke="#b97a2e" stroke-width="3">
        <path d="M44 126 Q90 54 136 126 Q118 112 90 112 Q62 112 44 126 Z"/>
        <path d="M154 126 Q200 54 246 126 Q228 112 200 112 Q172 112 154 126 Z"/>
        <path d="M264 126 Q310 54 356 126 Q338 112 310 112 Q282 112 264 126 Z"/>
      </g>
      <g stroke="#b97a2e" stroke-width="3" fill="none">
        <path d="M74 86 L82 112"/><path d="M106 86 L98 112"/>
        <path d="M184 86 L192 112"/><path d="M216 86 L208 112"/>
        <path d="M294 86 L302 112"/><path d="M326 86 L318 112"/>
      </g>
      <ellipse cx="110" cy="222" rx="72" ry="30" fill="#c27c3a"/>
      <ellipse cx="270" cy="222" rx="72" ry="30" fill="#b46e30"/>
      <g stroke="#ecbb7d" stroke-width="5" stroke-linecap="round">
        <line x1="76" y1="226" x2="92" y2="206"/><line x1="104" y1="230" x2="120" y2="208"/><line x1="132" y1="230" x2="148" y2="210"/>
        <line x1="236" y1="226" x2="252" y2="206"/><line x1="264" y1="230" x2="280" y2="208"/><line x1="292" y1="230" x2="308" y2="210"/>
      </g>
      <rect x="150" y="190" width="100" height="22" rx="11" fill="#d08a40" transform="rotate(-8 200 201)"/>`),
  },
  {
    id: 'dining-room',
    svg: svg(`
      <rect width="400" height="300" fill="#9fb9a5"/>
      <rect y="214" width="400" height="86" fill="#a26f4c"/>
      <g stroke="#8d5e3f" stroke-width="3"><line x1="0" y1="242" x2="400" y2="242"/><line x1="0" y1="272" x2="400" y2="272"/><line x1="80" y1="214" x2="70" y2="242"/><line x1="230" y1="242" x2="222" y2="272"/><line x1="320" y1="214" x2="314" y2="242"/></g>
      <rect x="36" y="38" width="96" height="110" fill="#dceff2" stroke="#f5efe4" stroke-width="8"/>
      <line x1="84" y1="38" x2="84" y2="148" stroke="#f5efe4" stroke-width="6"/><line x1="36" y1="92" x2="132" y2="92" stroke="#f5efe4" stroke-width="6"/>
      <rect x="282" y="54" width="70" height="50" fill="#f2d16b" stroke="#f5efe4" stroke-width="6"/>
      <circle cx="306" cy="80" r="12" fill="#e8743b"/><path d="M318 96 L338 66 L346 96 Z" fill="#2f7f7a"/>
      <line x1="214" y1="0" x2="214" y2="58" stroke="#3b3b3b" stroke-width="3"/>
      <circle cx="214" cy="88" r="40" fill="#fff3c4" opacity="0.35"/>
      <path d="M190 58 L238 58 L250 84 L178 84 Z" fill="#e9b44c"/>
      <ellipse cx="214" cy="178" rx="92" ry="18" fill="#f7f1e6"/>
      <path d="M122 178 Q120 214 132 224 L296 224 Q308 214 306 178 Z" fill="#f2e9d8"/>
      <g fill="#1f3048">
        <rect x="80" y="130" width="12" height="64" rx="4"/><rect x="80" y="186" width="56" height="12" rx="4"/><rect x="82" y="196" width="8" height="40"/><rect x="126" y="196" width="8" height="40"/>
        <rect x="336" y="130" width="12" height="64" rx="4"/><rect x="292" y="186" width="56" height="12" rx="4"/><rect x="294" y="196" width="8" height="40"/><rect x="338" y="196" width="8" height="40"/>
      </g>
      <g fill="#fbf7ef"><ellipse cx="184" cy="174" rx="18" ry="5"/><ellipse cx="244" cy="174" rx="18" ry="5"/></g>
      <path d="M362 216 L392 216 L386 250 L368 250 Z" fill="#c9643b"/>
      <g fill="#4f8a3e"><ellipse cx="368" cy="196" rx="8" ry="24" transform="rotate(-20 368 196)"/><ellipse cx="386" cy="194" rx="8" ry="24" transform="rotate(20 386 194)"/></g>
      <ellipse cx="377" cy="186" rx="7" ry="26" fill="#6aa84f"/>`),
  },
  /* The Copper Finch's other three photos, in the dining room's colours so the
     four read as one place. The venue sheet draws each "Happening here" card
     over a different photo (photos[1..3]), and a card is a wide strip cut from
     the middle of the picture, so each subject sits between y 80 and y 220.
     The counter has a quiz board where a bar would have taps: no drinks in
     any frame. */
  {
    id: 'counter',
    svg: svg(`
      <rect width="400" height="300" fill="#9fb9a5"/>
      <line x1="80" y1="0" x2="80" y2="30" stroke="#3b3b3b" stroke-width="3"/>
      <circle cx="80" cy="52" r="30" fill="#fff3c4" opacity="0.3"/>
      <path d="M62 30 L98 30 L106 50 L54 50 Z" fill="#e9b44c"/>
      <line x1="320" y1="0" x2="320" y2="30" stroke="#3b3b3b" stroke-width="3"/>
      <circle cx="320" cy="52" r="30" fill="#fff3c4" opacity="0.3"/>
      <path d="M302 30 L338 30 L346 50 L294 50 Z" fill="#e9b44c"/>
      <g transform="translate(0 16)">
      <rect x="128" y="66" width="144" height="78" rx="4" fill="#2f3b36" stroke="#8a5a3b" stroke-width="7"/>
      <path d="M186 92 q0 -14 14 -14 q14 0 14 12 q0 9 -10 13 q-4 2 -4 9 l0 4" fill="none" stroke="#f5efe4" stroke-width="5" stroke-linecap="round"/>
      <circle cx="200" cy="129" r="3.5" fill="#f5efe4"/>
      <g stroke="#f5efe4" stroke-width="3" stroke-linecap="round" opacity="0.55">
        <line x1="142" y1="84" x2="166" y2="84"/><line x1="142" y1="98" x2="160" y2="98"/><line x1="142" y1="112" x2="168" y2="112"/><line x1="142" y1="126" x2="158" y2="126"/>
        <line x1="234" y1="84" x2="258" y2="84"/><line x1="240" y1="98" x2="258" y2="98"/><line x1="232" y1="112" x2="258" y2="112"/><line x1="242" y1="126" x2="258" y2="126"/>
      </g>
      <rect x="54" y="136" width="20" height="22" rx="3" fill="#2f7f7a"/>
      <g stroke-width="4" stroke-linecap="round"><line x1="58" y1="138" x2="54" y2="122" stroke="#f2c94c"/><line x1="64" y1="138" x2="66" y2="120" stroke="#f2c94c"/><line x1="70" y1="138" x2="76" y2="124" stroke="#e8743b"/></g>
      <rect x="92" y="148" width="40" height="10" rx="2" fill="#fbf7ef"/><rect x="96" y="143" width="40" height="7" rx="2" fill="#f2e9d8"/>
      <rect x="306" y="152" width="34" height="6" rx="2" fill="#6b3a21"/>
      <path d="M310 152 Q323 128 336 152 Z" fill="#e9b44c"/><circle cx="323" cy="134" r="3" fill="#e9b44c"/>
      <rect y="158" width="400" height="12" fill="#8a5a3b"/>
      <rect y="170" width="400" height="80" fill="#6f4630"/>
      <g stroke="#5e3b28" stroke-width="3"><line x1="66" y1="170" x2="66" y2="250"/><line x1="146" y1="170" x2="146" y2="250"/><line x1="254" y1="170" x2="254" y2="250"/><line x1="334" y1="170" x2="334" y2="250"/></g>
      <rect y="250" width="400" height="50" fill="#a26f4c"/>
      <g stroke="#8d5e3f" stroke-width="3"><line x1="0" y1="274" x2="400" y2="274"/><line x1="120" y1="250" x2="112" y2="274"/><line x1="290" y1="274" x2="284" y2="300"/></g>
      <g fill="#1f3048">
        <ellipse cx="96" cy="206" rx="28" ry="8"/><rect x="92" y="210" width="8" height="66"/><rect x="80" y="246" width="32" height="5" rx="2"/>
        <ellipse cx="200" cy="206" rx="28" ry="8"/><rect x="196" y="210" width="8" height="66"/><rect x="184" y="246" width="32" height="5" rx="2"/>
        <ellipse cx="304" cy="206" rx="28" ry="8"/><rect x="300" y="210" width="8" height="66"/><rect x="288" y="246" width="32" height="5" rx="2"/>
      </g>
      <g fill="#2b4364"><ellipse cx="96" cy="203" rx="24" ry="5"/><ellipse cx="200" cy="203" rx="24" ry="5"/><ellipse cx="304" cy="203" rx="24" ry="5"/></g>
      </g>`),
  },
  {
    id: 'stage',
    svg: svg(`
      <rect width="400" height="300" fill="#9fb9a5"/>
      <rect x="56" y="0" width="288" height="216" fill="#22324a"/>
      <g stroke="#2b3f5d" stroke-width="12"><line x1="86" y1="0" x2="86" y2="216"/><line x1="134" y1="0" x2="134" y2="216"/><line x1="182" y1="0" x2="182" y2="216"/><line x1="230" y1="0" x2="230" y2="216"/><line x1="278" y1="0" x2="278" y2="216"/><line x1="320" y1="0" x2="320" y2="216"/></g>
      <path d="M -10 66 Q 100 112 200 78 Q 300 112 410 66" fill="none" stroke="#f5efe4" stroke-width="2" opacity="0.45"/>
      <g>
        <circle cx="42" cy="90" r="12" fill="#f5b942" opacity="0.18"/><circle cx="42" cy="90" r="4.5" fill="#f5b942"/>
        <circle cx="100" cy="100" r="12" fill="#f5b942" opacity="0.18"/><circle cx="100" cy="100" r="4.5" fill="#f5b942"/>
        <circle cx="152" cy="98" r="12" fill="#f5b942" opacity="0.18"/><circle cx="152" cy="98" r="4.5" fill="#f5b942"/>
        <circle cx="200" cy="86" r="12" fill="#f5b942" opacity="0.18"/><circle cx="200" cy="86" r="4.5" fill="#f5b942"/>
        <circle cx="248" cy="98" r="12" fill="#f5b942" opacity="0.18"/><circle cx="248" cy="98" r="4.5" fill="#f5b942"/>
        <circle cx="300" cy="100" r="12" fill="#f5b942" opacity="0.18"/><circle cx="300" cy="100" r="4.5" fill="#f5b942"/>
        <circle cx="358" cy="90" r="12" fill="#f5b942" opacity="0.18"/><circle cx="358" cy="90" r="4.5" fill="#f5b942"/>
      </g>
      <ellipse cx="200" cy="214" rx="150" ry="18" fill="#f5b942" opacity="0.08"/>
      <rect x="36" y="204" width="328" height="12" fill="#c58a5c"/>
      <rect x="36" y="216" width="328" height="34" fill="#8d5e3f"/>
      <g stroke="#7a4f34" stroke-width="3"><line x1="118" y1="216" x2="118" y2="250"/><line x1="200" y1="216" x2="200" y2="250"/><line x1="282" y1="216" x2="282" y2="250"/></g>
      <rect y="250" width="400" height="50" fill="#a26f4c"/>
      <line x1="0" y1="274" x2="400" y2="274" stroke="#8d5e3f" stroke-width="3"/>
      <g stroke="#0f1726" stroke-linecap="round">
        <line x1="150" y1="126" x2="150" y2="202" stroke-width="5"/>
        <line x1="150" y1="202" x2="134" y2="206" stroke-width="4"/><line x1="150" y1="202" x2="166" y2="206" stroke-width="4"/>
        <line x1="150" y1="128" x2="168" y2="118" stroke-width="4"/>
      </g>
      <rect x="164" y="104" width="12" height="22" rx="6" fill="#c7ccd4" transform="rotate(-58 170 115)"/>
      <g fill="#8a5a3b"><rect x="282" y="172" width="44" height="8" rx="3"/><rect x="286" y="180" width="6" height="24"/><rect x="316" y="180" width="6" height="24"/></g>
      <g transform="rotate(-10 226 160)">
        <rect x="221" y="84" width="10" height="64" fill="#6b3a21"/>
        <rect x="218" y="76" width="16" height="14" rx="3" fill="#4a2a17"/>
        <g fill="#e6dccb"><circle cx="216" cy="80" r="2"/><circle cx="216" cy="86" r="2"/><circle cx="236" cy="80" r="2"/><circle cx="236" cy="86" r="2"/></g>
        <circle cx="226" cy="152" r="21" fill="#e0a052"/>
        <circle cx="226" cy="184" r="27" fill="#e0a052"/>
        <circle cx="226" cy="160" r="8" fill="#3b2416"/>
        <rect x="214" y="186" width="24" height="5" rx="2" fill="#6b3a21"/>
        <g stroke="#f5efe4" stroke-width="1" opacity="0.7"><line x1="223" y1="88" x2="223" y2="188"/><line x1="226" y1="88" x2="226" y2="188"/><line x1="229" y1="88" x2="229" y2="188"/></g>
      </g>
      <g stroke="#0f1726" stroke-width="4" stroke-linecap="round"><line x1="214" y1="204" x2="226" y2="190"/><line x1="246" y1="204" x2="234" y2="190"/></g>`),
  },
  {
    id: 'wings',
    svg: svg(`
      <defs><clipPath id="paper"><ellipse cx="200" cy="164" rx="104" ry="36"/></clipPath></defs>
      <rect width="400" height="300" fill="#9fb9a5"/>
      <rect x="26" y="0" width="92" height="66" fill="#dceff2" stroke="#f5efe4" stroke-width="8"/>
      <line x1="72" y1="0" x2="72" y2="66" stroke="#f5efe4" stroke-width="6"/>
      <rect y="92" width="400" height="208" fill="#a26f4c"/>
      <g fill="none" stroke="#8d5e3f" stroke-width="3" opacity="0.8"><path d="M0 128 C120 120 280 136 400 126"/><path d="M0 232 C140 222 260 240 400 228"/><path d="M0 276 C150 266 250 284 400 270"/></g>
      <g transform="translate(304 84)">
        <rect x="-16" y="52" width="32" height="8" rx="2" fill="#6b3a21"/>
        <rect x="-5" y="38" width="10" height="16" fill="#e9b44c"/>
        <path d="M-20 4 L20 4 Q20 36 0 40 Q-20 36 -20 4 Z" fill="#e9b44c"/>
        <path d="M-20 10 Q-34 12 -30 24 Q-26 30 -16 28" fill="none" stroke="#e9b44c" stroke-width="5"/>
        <path d="M20 10 Q34 12 30 24 Q26 30 16 28" fill="none" stroke="#e9b44c" stroke-width="5"/>
        <path d="M-10 10 Q-8 26 2 32" fill="none" stroke="#f6d77a" stroke-width="3" stroke-linecap="round"/>
      </g>
      <ellipse cx="200" cy="176" rx="122" ry="44" fill="#5e2a1d" opacity="0.35"/>
      <ellipse cx="200" cy="168" rx="116" ry="44" fill="#9a3b2a"/>
      <ellipse cx="200" cy="164" rx="104" ry="36" fill="#fbf7ef"/>
      <g clip-path="url(#paper)" fill="#d64a3b" opacity="0.85">
        <rect x="96" y="128" width="16" height="16"/><rect x="128" y="128" width="16" height="16"/><rect x="160" y="128" width="16" height="16"/><rect x="192" y="128" width="16" height="16"/><rect x="224" y="128" width="16" height="16"/><rect x="256" y="128" width="16" height="16"/><rect x="288" y="128" width="16" height="16"/>
        <rect x="112" y="144" width="16" height="16"/><rect x="144" y="144" width="16" height="16"/><rect x="176" y="144" width="16" height="16"/><rect x="208" y="144" width="16" height="16"/><rect x="240" y="144" width="16" height="16"/><rect x="272" y="144" width="16" height="16"/>
        <rect x="96" y="160" width="16" height="16"/><rect x="128" y="160" width="16" height="16"/><rect x="160" y="160" width="16" height="16"/><rect x="192" y="160" width="16" height="16"/><rect x="224" y="160" width="16" height="16"/><rect x="256" y="160" width="16" height="16"/><rect x="288" y="160" width="16" height="16"/>
        <rect x="112" y="176" width="16" height="16"/><rect x="144" y="176" width="16" height="16"/><rect x="176" y="176" width="16" height="16"/><rect x="208" y="176" width="16" height="16"/><rect x="240" y="176" width="16" height="16"/><rect x="272" y="176" width="16" height="16"/>
        <rect x="96" y="192" width="16" height="16"/><rect x="128" y="192" width="16" height="16"/><rect x="160" y="192" width="16" height="16"/><rect x="192" y="192" width="16" height="16"/><rect x="224" y="192" width="16" height="16"/><rect x="256" y="192" width="16" height="16"/><rect x="288" y="192" width="16" height="16"/>
      </g>
      <g>
        <g transform="rotate(-24 150 162)"><ellipse cx="150" cy="162" rx="26" ry="15" fill="#b8481f"/><ellipse cx="146" cy="157" rx="15" ry="6" fill="#d9773a"/></g>
        <g transform="rotate(18 196 150)"><ellipse cx="196" cy="150" rx="27" ry="15" fill="#c4522a"/><ellipse cx="192" cy="145" rx="15" ry="6" fill="#e08a46"/></g>
        <g transform="rotate(-8 246 160)"><ellipse cx="246" cy="160" rx="26" ry="15" fill="#b8481f"/><ellipse cx="242" cy="155" rx="15" ry="6" fill="#d9773a"/></g>
        <g transform="rotate(30 176 180)"><ellipse cx="176" cy="180" rx="24" ry="14" fill="#c4522a"/><ellipse cx="172" cy="175" rx="13" ry="5" fill="#e08a46"/></g>
        <g transform="rotate(-30 226 182)"><ellipse cx="226" cy="182" rx="25" ry="14" fill="#b8481f"/><ellipse cx="222" cy="177" rx="13" ry="5" fill="#d9773a"/></g>
        <g fill="#f3e2c6"><circle cx="126" cy="170" r="6"/><circle cx="268" cy="150" r="6"/><circle cx="202" cy="128" r="5"/><circle cx="248" cy="196" r="5"/></g>
      </g>
      <g fill="#7cbf5a"><rect x="40" y="166" width="44" height="9" rx="4" transform="rotate(-14 62 170)"/><rect x="46" y="184" width="44" height="9" rx="4" transform="rotate(-6 68 188)"/></g>
      <ellipse cx="76" cy="132" rx="24" ry="9" fill="#fbf7ef"/><ellipse cx="76" cy="130" rx="18" ry="6" fill="#e8743b"/>
      <ellipse cx="330" cy="196" rx="24" ry="9" fill="#fbf7ef"/><ellipse cx="330" cy="194" rx="18" ry="6" fill="#f2c94c"/>
      <path d="M300 226 L372 218 L380 246 L306 254 Z" fill="#f5efe4"/><path d="M306 254 L380 246 L376 252 L310 260 Z" fill="#dcd3c2"/>`),
  },
  {
    id: 'storefront',
    svg: svg(`
      <rect width="400" height="300" fill="#d4765c"/>
      <rect x="0" y="16" width="400" height="44" fill="#22324a"/>
      <circle cx="200" cy="38" r="12" fill="#e9b44c"/><path d="M188 38 Q200 22 212 38" fill="#5e9b55"/>
      <g>
        <path d="M0 66 L400 66 L400 100 L0 100 Z" fill="#f5ead6"/>
        <g fill="#2f7f7a"><rect x="0" y="66" width="40" height="34"/><rect x="80" y="66" width="40" height="34"/><rect x="160" y="66" width="40" height="34"/><rect x="240" y="66" width="40" height="34"/><rect x="320" y="66" width="40" height="34"/></g>
        <g fill="#f5ead6"><circle cx="20" cy="100" r="20"/><circle cx="100" cy="100" r="20"/><circle cx="180" cy="100" r="20"/><circle cx="260" cy="100" r="20"/><circle cx="340" cy="100" r="20"/></g>
        <g fill="#2f7f7a"><circle cx="60" cy="100" r="20"/><circle cx="140" cy="100" r="20"/><circle cx="220" cy="100" r="20"/><circle cx="300" cy="100" r="20"/><circle cx="380" cy="100" r="20"/></g>
      </g>
      <rect x="34" y="132" width="210" height="118" fill="#bfe2ea" stroke="#22324a" stroke-width="6"/>
      <path d="M60 132 L110 132 L60 200 Z" fill="#ffffff" opacity="0.45"/><path d="M130 132 L160 132 L90 250 L60 250 Z" fill="#ffffff" opacity="0.3"/>
      <g fill="#22324a"><ellipse cx="96" cy="222" rx="22" ry="6"/><rect x="93" y="222" width="6" height="26"/><ellipse cx="180" cy="222" rx="22" ry="6"/><rect x="177" y="222" width="6" height="26"/></g>
      <rect x="264" y="128" width="96" height="146" fill="#22324a"/>
      <rect x="278" y="144" width="68" height="70" fill="#4d6a86"/>
      <circle cx="346" cy="232" r="6" fill="#e9b44c"/>
      <rect x="0" y="274" width="400" height="26" fill="#cfc6b7"/>
      <rect x="30" y="250" width="218" height="24" fill="#8a5a3b"/>
      <g fill="#e8743b"><circle cx="54" cy="248" r="7"/><circle cx="110" cy="246" r="7"/><circle cx="170" cy="248" r="7"/><circle cx="226" cy="246" r="7"/></g>
      <g fill="#f2c94c"><circle cx="80" cy="244" r="6"/><circle cx="140" cy="244" r="6"/><circle cx="198" cy="244" r="6"/></g>
      <g fill="#5e9b55"><circle cx="66" cy="252" r="6"/><circle cx="124" cy="252" r="6"/><circle cx="184" cy="252" r="6"/><circle cx="240" cy="252" r="5"/></g>`),
  },
  {
    id: 'salad',
    svg: svg(`
      <rect width="400" height="300" fill="#5d83ad"/>
      <g stroke="#6b90b8" stroke-width="10"><line x1="0" y1="50" x2="400" y2="50"/><line x1="0" y1="150" x2="400" y2="150"/><line x1="0" y1="250" x2="400" y2="250"/><line x1="70" y1="0" x2="70" y2="300"/><line x1="200" y1="0" x2="200" y2="300"/><line x1="330" y1="0" x2="330" y2="300"/></g>
      <circle cx="200" cy="150" r="118" fill="#fbf7ef"/>
      <circle cx="200" cy="150" r="92" fill="#f1eadc"/>
      <g fill="#5f9a45">
        <ellipse cx="170" cy="120" rx="34" ry="18" transform="rotate(-25 170 120)"/><ellipse cx="232" cy="118" rx="34" ry="18" transform="rotate(25 232 118)"/>
        <ellipse cx="160" cy="170" rx="34" ry="18" transform="rotate(20 160 170)"/><ellipse cx="236" cy="176" rx="34" ry="18" transform="rotate(-20 236 176)"/>
      </g>
      <g fill="#7cbf5a">
        <ellipse cx="200" cy="140" rx="30" ry="16" transform="rotate(10 200 140)"/><ellipse cx="196" cy="186" rx="28" ry="14"/><ellipse cx="200" cy="104" rx="24" ry="12"/>
      </g>
      <g fill="#d64a3b"><circle cx="176" cy="146" r="12"/><circle cx="226" cy="150" r="12"/><circle cx="204" cy="166" r="10"/></g>
      <g fill="#f2d07a"><circle cx="173" cy="143" r="2"/><circle cx="179" cy="149" r="2"/><circle cx="223" cy="147" r="2"/><circle cx="229" cy="153" r="2"/></g>
      <g fill="#cfe8a0" stroke="#6a9a4b" stroke-width="3"><circle cx="150" cy="140" r="10"/><circle cx="250" cy="132" r="10"/><circle cx="214" cy="198" r="10"/></g>
      <g fill="#d9dde3">
        <rect x="44" y="70" width="10" height="160" rx="5"/><rect x="34" y="60" width="30" height="40" rx="6"/>
        <rect x="346" y="70" width="10" height="160" rx="5"/><path d="M346 70 Q370 100 356 150 L346 150 Z"/>
      </g>`),
  },
  {
    id: 'sushi',
    svg: svg(`
      <rect width="400" height="300" fill="#2f3e4e"/>
      <rect x="54" y="98" width="292" height="122" rx="18" fill="#c9925e"/>
      <rect x="54" y="206" width="292" height="14" rx="7" fill="#a8743f"/>
      <g>
        <circle cx="110" cy="146" r="25" fill="#1f2a24"/><circle cx="110" cy="146" r="20" fill="#fbfaf5"/><circle cx="110" cy="146" r="8" fill="#f08a4b"/>
        <circle cx="168" cy="146" r="25" fill="#1f2a24"/><circle cx="168" cy="146" r="20" fill="#fbfaf5"/><circle cx="168" cy="146" r="8" fill="#6ab04c"/>
        <circle cx="139" cy="188" r="25" fill="#1f2a24"/><circle cx="139" cy="188" r="20" fill="#fbfaf5"/><circle cx="139" cy="188" r="8" fill="#f08a4b"/>
      </g>
      <g>
        <ellipse cx="256" cy="150" rx="40" ry="16" fill="#fbfaf5"/>
        <path d="M216 146 Q256 116 296 146 Q256 136 216 146 Z" fill="#f38b52"/>
        <path d="M228 138 L236 146 M248 132 L254 142 M268 132 L272 142" stroke="#fbd4bd" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="256" cy="194" rx="40" ry="16" fill="#fbfaf5"/>
        <path d="M216 190 Q256 160 296 190 Q256 180 216 190 Z" fill="#f38b52"/>
        <path d="M228 182 L236 190 M248 176 L254 186 M268 176 L272 186" stroke="#fbd4bd" stroke-width="3" stroke-linecap="round"/>
      </g>
      <path d="M312 120 q12 -10 20 4 q-8 12 -20 -4 z" fill="#8cc152"/>
      <g fill="#f2b8b0"><ellipse cx="318" cy="186" rx="10" ry="5"/><ellipse cx="326" cy="194" rx="10" ry="5"/></g>
      <g stroke="#e8d2a8" stroke-width="8" stroke-linecap="round"><line x1="70" y1="70" x2="330" y2="52"/><line x1="72" y1="84" x2="332" y2="66"/></g>`),
  },
  {
    id: 'ice-cream',
    svg: svg(`
      <rect width="400" height="300" fill="#f4bfcb"/>
      <g stroke-width="5" stroke-linecap="round">
        <line x1="40" y1="40" x2="52" y2="48" stroke="#5aa9e6"/><line x1="340" y1="60" x2="352" y2="52" stroke="#f9c74f"/>
        <line x1="70" y1="230" x2="80" y2="240" stroke="#90be6d"/><line x1="330" y1="240" x2="344" y2="236" stroke="#5aa9e6"/>
        <line x1="300" y1="140" x2="310" y2="150" stroke="#f9844a"/><line x1="90" y1="130" x2="98" y2="120" stroke="#f9c74f"/>
      </g>
      <path d="M164 160 L236 160 L200 290 Z" fill="#e0a35a"/>
      <g stroke="#c98a45" stroke-width="3"><line x1="176" y1="170" x2="214" y2="250"/><line x1="200" y1="166" x2="226" y2="214"/><line x1="224" y1="170" x2="186" y2="250"/><line x1="200" y1="166" x2="174" y2="214"/></g>
      <circle cx="200" cy="146" r="44" fill="#f7f0e1"/>
      <circle cx="200" cy="104" r="40" fill="#a8e0c5"/>
      <circle cx="200" cy="66" r="34" fill="#e77a8f"/>
      <path d="M170 156 q6 18 12 0 q6 22 14 0 q6 16 12 0" fill="#f7f0e1"/>
      <circle cx="206" cy="30" r="10" fill="#c62828"/>
      <path d="M206 22 Q210 8 222 4" fill="none" stroke="#5e8f4a" stroke-width="3"/>`),
  },
  {
    id: 'pancakes',
    svg: svg(`
      <rect width="400" height="300" fill="#f6d77a"/>
      <g fill="#f8e09a"><circle cx="60" cy="60" r="30"/><circle cx="350" cy="230" r="34"/><circle cx="340" cy="60" r="16"/></g>
      <ellipse cx="200" cy="230" rx="160" ry="42" fill="#fffaf0"/>
      <ellipse cx="200" cy="224" rx="132" ry="30" fill="#f3ebdc"/>
      <g>
        <ellipse cx="200" cy="208" rx="104" ry="22" fill="#c9853d"/><ellipse cx="200" cy="200" rx="104" ry="22" fill="#e2a256"/>
        <ellipse cx="200" cy="182" rx="100" ry="21" fill="#c9853d"/><ellipse cx="200" cy="174" rx="100" ry="21" fill="#e2a256"/>
        <ellipse cx="200" cy="156" rx="96" ry="20" fill="#c9853d"/><ellipse cx="200" cy="148" rx="96" ry="20" fill="#e2a256"/>
        <ellipse cx="200" cy="130" rx="92" ry="19" fill="#c9853d"/><ellipse cx="200" cy="122" rx="92" ry="19" fill="#eab468"/>
      </g>
      <rect x="182" y="104" width="36" height="22" rx="6" fill="#fff1a8"/>
      <g fill="#3f4fa0"><circle cx="96" cy="232" r="9"/><circle cx="112" cy="242" r="9"/><circle cx="292" cy="236" r="9"/></g>
      <g fill="#d1384d"><circle cx="310" cy="226" r="10"/><circle cx="80" cy="220" r="10"/><circle cx="150" cy="114" r="8"/><circle cx="246" cy="112" r="8"/></g>`),
  },
];

const BY_ID = new Map(VENUE_ART.map((a) => [a.id, a]));

/* Refs that always get a particular picture. The demo venue's photo points at
   the proxy with the first ref (see the seed in capture-screenshots.mjs).
   The dining room rather than the burger: the venue sheet repeats the venue's
   photo behind every "Happening here" card, and a room reads as the place the
   events happen in. The next three are its further photos, which the rig hands
   the venue sheet as Place Details would for a listed venue, so each "Happening
   here" card has a picture of its own; the logo is the owner's profile picture
   (venue_profiles.photo_url), which the dashboard draws in its round badge. */
const PINNED = {
  'shots-copper-finch': 'dining-room',
  'shots-copper-finch-counter': 'counter',
  'shots-copper-finch-stage': 'stage',
  'shots-copper-finch-wings': 'wings',
  'shots-copper-finch-logo': 'burger',
};

/* Which pictures a screen draws from. A search for pizza that shows croissants
   and ice cream reads as broken, so a driver can narrow the pool to pictures
   that fit what its screen is about (setVenueArtTheme). Without a theme every
   picture except the Copper Finch's five (its dining room, its logo's burger
   and its three further photos) is in play, so no other venue in a frame
   carries The Copper Finch's picture, and setVenueArtTheme drops the five
   from any theme that names one. */
const COPPER_FINCH_ONLY = new Set(Object.values(PINNED));
const ALL = VENUE_ART.map((a) => a.id).filter((id) => !COPPER_FINCH_ONLY.has(id));

/* Same venue, same picture, for the whole run (every size and theme pass), and
   neighbours get different ones: refs take pictures from the pool in the order
   they are first asked for, round robin. Assignments are kept per pool, so a
   venue keeps its picture on every pass of the same screen. */
const assigned = new Map(); // `${pool}|${ref}` -> id
const nextInPool = new Map(); // pool -> next index
function artIdForRef(ref, theme) {
  if (PINNED[ref]) return PINNED[ref];
  // An invented place names its own drawing: ref=shots-art-<id>.
  if (typeof ref === 'string' && ref.startsWith('shots-art-') && BY_ID.has(ref.slice(10))) return ref.slice(10);
  const pool = theme && theme.length ? theme : ALL;
  const key = `${pool.join(',')}|${ref}`;
  if (!assigned.has(key)) {
    const i = nextInPool.get(pool.join(',')) || 0;
    assigned.set(key, pool[i % pool.length]);
    nextInPool.set(pool.join(','), i + 1);
  }
  return assigned.get(key);
}

/* Narrow the pictures for every page in `context` to `ids` (null for all).
   The Copper Finch's own pictures never join a pool, whatever a theme names. */
export function setVenueArtTheme(context, ids) {
  const pool = ids && ids.length ? ids.filter((id) => BY_ID.has(id) && !COPPER_FINCH_ONLY.has(id)) : [];
  context.__venueArtTheme = pool.length ? pool : null;
}

/* Hand out the current pool's pictures to `refs` in that order. A list asks for
   its photos in whatever order its requests happen to leave (and sorts its rows
   afterwards), so first-come assignment can put the same picture on three
   neighbouring rows. A driver that knows the order on screen passes it here and
   then reloads the images (refreshVisibleVenueArt). */
export function assignVenueArtInOrder(context, refs) {
  const pool = context.__venueArtTheme && context.__venueArtTheme.length ? context.__venueArtTheme : ALL;
  const seen = new Set();
  let i = 0;
  for (const ref of refs) {
    if (!ref || seen.has(ref) || PINNED[ref]) continue;
    seen.add(ref);
    assigned.set(`${pool.join(',')}|${ref}`, pool[i % pool.length]);
    i += 1;
  }
}

/* Read the venue photos on screen in document order, give them the pool's
   pictures in that order, and make the page fetch them again. Only the image
   URLs change (a cache-busting parameter); the screen itself is untouched. */
export async function refreshVisibleVenueArt(page) {
  const refs = await page.evaluate(() => [...document.images]
    .map((img) => img.currentSrc || img.src)
    .filter((src) => src.includes('/api/venues/photo'))
    .map((src) => new URL(src).searchParams.get('ref')));
  assignVenueArtInOrder(page.context(), refs);
  await page.evaluate(() => {
    for (const img of document.images) {
      if (!img.src.includes('/api/venues/photo')) continue;
      const u = new URL(img.src);
      u.searchParams.set('art', String(Date.now()));
      img.src = u.toString();
    }
  });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
}

/* Rasterise every picture once, at 4:3 and twice the largest size the app asks
   the proxy for (maxwidth 600), so cards stay sharp at 3x. */
let rendered = null;
export async function renderVenueArt(sharp) {
  if (rendered) return rendered;
  rendered = new Map();
  for (const a of VENUE_ART) {
    const buf = await sharp(Buffer.from(a.svg), { density: 300 })
      .resize(1200, 900)
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    rendered.set(a.id, buf);
  }
  return rendered;
}

/* Answer the photo proxy from the drawings above, for every page in `context`.
   `served` (optional) collects what was handed out, for the run log. */
export async function installVenueArt(context, sharp, served) {
  const art = await renderVenueArt(sharp);
  await context.route(
    (url) => url.pathname === '/api/venues/photo',
    async (route) => {
      const url = new URL(route.request().url());
      const ref = url.searchParams.get('ref') || url.search || 'none';
      const id = artIdForRef(ref, context.__venueArtTheme);
      if (served) served.add(id);
      if (process.env.SHOTS_ART_LOG) {
        console.log(`[art] ${(context.__venueArtTheme || ['all']).join('+')} ${ref.slice(-16)} -> ${id} (${url.searchParams.get('maxwidth')})`);
      }
      await route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
        body: art.get(id) || art.get('storefront'),
      });
    },
  );
}

export function artIds() {
  return [...BY_ID.keys()];
}
