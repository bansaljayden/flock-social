import React, { useEffect } from 'react';
import './LandingPage.css';
import './AiPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';
import { shareThisPage } from './shareCard';

// /ai, "How the AI works": the four models in Flock, one band each, with the
// figures from the Stevens pitch video. Built on the landing page's
// stylesheet like /how-it-works.
//
// The figures are stills of the video's own composition, cut for the web
// (public/ai-figures/): no deck header, no accuracy panels, no venue photo,
// and two figures the claims ledger only allows with a note beside them
// ("106 inputs", C-036; "runs on the sensor", C-112) painted out. Birdie has
// no figure of its own: that page of the video shows a venue photo, which
// may not be republished. four-models-v3 (2026-11-26) is a new still of the
// same page (frame 975), cut at the same box, with Starling's second chip
// saying what the model does ("corrects the usual week") in place of the
// serving version's "800 trees".
//
// What the copy rests on (competitions/_shared/claims.md):
//   Starling learns how far each hour moves from the venue's usual week
//     (label_type delta) from the hour, weather, events and the kind of
//     venue; 30 training cities on six continents; tested on three
//     cities it never trained on                      C-040, C-042, C-159
//   the version serving today, 2.6.0-starling, trained 2026-08-18:
//     XGBoost, 800 trees up to 8 deep (model_metadata.json)          C-035
//   the next version: 2,000 trees up to 10 deep, chosen 2026-11-26 on
//     training cities (backend/scripts/ml/RETRAIN.md); it learns from
//     live readings through 11 November and ships only if it passes all
//     eight tests of the gate on 12 to 25 November (research paper 7.2).
//     Not trained as of 2026-11-26, so the copy says "will"
//   the readings are 0 to 100 estimates, not head counts          C-058
//   where Flock knows the venue's usual week, the card's number starts
//     from Starling's forecast: CROWD_SERVE_MODE=model since the evening
//     of 2026-11-01 (C-157). Model mode then adds 0.5 x the venue's
//     trailing offset, the median gap of its live readings in the 28 days
//     before the hour (backend/services/mlPredictor.js DEVIATION_WEIGHT,
//     trailingOffsetBefore; v2.6.0 has no offset input). No live reading
//     has arrived since 2026-11-25 15:59 UTC, so the nowcast moves no
//     number and the offset empties by about 2026-12-23, hence "until
//     late December". The delta model cannot score a venue with no usual
//     week; that venue gets its kind's pattern or the rule engine
//   a venue can set its live number; groups see it credited to the place (utils/venueLabel.js picks the noun);
//     it lasts 90 minutes                                         C-131
//   Owl: runs on the Pi; generated frames and 28 public
//     datasets; not yet in a venue        models/NOTICE.md, C-112 (out of date)
//   Roost's advisor: numbers about the venue are filled in from
//     its measured facts, and a number it states about the venue
//     that the facts do not back loses its sentence (2026-10-28;
//     backend/services/advisorAnswer.js). It used to be barred
//     from typing a digit at all                                  C-080, C-105
// No accuracy figure is quoted: /research has them with their limits.

const DESCRIPTION = 'The four AI models in Flock: the crowd forecast, the Owl people counter, Roost’s advisor and Birdie, what each one reads and how it was checked.';

// Every figure, at the two widths each file was written at. fluxPages.test.js
// checks each file exists at the width it claims.
export const FIGURES = {
  // -v2 since 2026-10-28, when Roost's box stopped saying "zero digits", and
  // -v3 since 2026-11-26, when Starling's box stopped leading with the tree
  // count: a file kept at the same name is served from Cloudflare's edge cache.
  four: { base: '/ai-figures/four-models-v3', one: 1100, two: 2200, height: 483 },
  trees: { base: '/ai-figures/starling-trees', one: 1100, two: 2200, height: 197 },
  map: { base: '/ai-figures/starling-map', one: 640, two: 1280, height: 256 },
  code: { base: '/ai-figures/starling-code', one: 640, two: 1280, height: 242 },
  band: { base: '/ai-figures/estimate-band', one: 900, two: 1800, height: 453 },
  pipeline: { base: '/ai-figures/owl-pipeline', one: 1100, two: 2200, height: 249 },
  owlCode: { base: '/ai-figures/owl-code', one: 640, two: 1280, height: 136 },
  flow: { base: '/ai-figures/owl-flow', one: 640, two: 1280, height: 107 },
  answer: { base: '/ai-figures/roost-answer-v2', one: 1100, two: 2200, height: 237 },
  check: { base: '/ai-figures/roost-check', one: 1100, two: 2200, height: 192 },
};

const WIDE = '(min-width: 1160px) 1080px, calc(100vw - 40px)';
const HALF = '(min-width: 960px) 520px, calc(100vw - 40px)';

// Each model's box on the four-models figure, as a link down to its section
// (the maintainer, 2026-10-21: "let me click starling roost owl etc box and then it
// will route me to where it is on the page"). Boxes are in percent of the
// image, measured on four-models@2x.webp (2200 x 966) from the box outlines;
// four-models-v2 and -v3 changed only words inside the boxes (Roost's, then
// Starling's chip), and v3 is cut from its render at the same box, so they hold.
export const MODEL_LINKS = [
  { href: '#starling', label: 'Starling', box: [0.95, 2.17, 35.77, 31.78] },
  { href: '#birdie', label: 'Birdie', box: [64.18, 2.17, 99.0, 31.78] },
  { href: '#owl', label: 'Owl', box: [0.95, 67.39, 35.77, 97.0] },
  { href: '#roost', label: 'Roost', box: [64.18, 67.39, 99.0, 97.0] },
];

function Figure({ img, sizes, alt, caption, links = null, eager = false, className = '' }) {
  const set = (ext) => `${img.base}.${ext} ${img.one}w, ${img.base}@2x.${ext} ${img.two}w`;
  return (
    <figure className={`ai-figure ${className}`.trim()}>
      <div className={links ? 'ai-plate has-links' : 'ai-plate'}>
        <picture>
          <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
          <source type="image/webp" srcSet={set('webp')} sizes={sizes} />
          <img
            src={`${img.base}.webp`}
            width={img.one} height={img.height}
            alt={alt}
            {...(eager ? { fetchPriority: 'high' } : { loading: 'lazy', decoding: 'async' })}
          />
        </picture>
        {links ? links.map((l) => (
          <a
            key={l.href}
            className="ai-hot"
            href={l.href}
            aria-label={`${l.label}, further down this page`}
            style={{
              left: `${l.box[0]}%`,
              top: `${l.box[1]}%`,
              width: `${(l.box[2] - l.box[0]).toFixed(2)}%`,
              height: `${(l.box[3] - l.box[1]).toFixed(2)}%`,
            }}
          />
        )) : null}
      </div>
      {caption ? <figcaption className="lp-fig-cap">{caption}</figcaption> : null}
    </figure>
  );
}

export default function AiPage() {
  const menu = useSiteMenu();
  const pageInert = menu.menuOpen ? { inert: true } : {};

  useEffect(() => {
    document.title = 'How the AI works | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
    return shareThisPage('/ai');
  }, []);

  return (
    <div className="lp ai">
      <a className="lp-skip" href="#ai-main">Skip to the main content</a>

      <SiteNav menu={menu} current="/ai" />

      <main id="ai-main" tabIndex={-1} {...pageInert}>
        <section className="lp-sec lp-sec-paper ai-hero" aria-labelledby="ai-h1">
          <div className="lp-wrap">
            <h1 id="ai-h1">How the AI works</h1>
            <p className="lp-lead ai-lead">
              Flock has four models, each with one job. We trained two of them
              ourselves. The other two are Google’s Gemini, with our own rules
              around it.
            </p>
            <Figure
              img={FIGURES.four}
              sizes={WIDE}
              links={MODEL_LINKS}
              caption="Tap a model to jump to it."
              eager
              alt="The four models around the Flock mark. Starling, trained by Flock, forecasts how busy a place will be: XGBoost, correcting each venue’s usual week. Birdie, Gemini with consent, helps the group pick a place: tool calls, and it asks first. Owl counts people in a room: a neural network with 718,550 weights. Roost, Gemini plus our checks, is an advisor that helps a venue make more money: claims checked, numbers from data."
            />
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" id="starling" aria-labelledby="ai-h-starling">
          <div className="lp-wrap">
            <h2 id="ai-h-starling">Starling forecasts how busy a place will be</h2>
            <div className="ai-text">
              <p>
                Starling learned, from venues in 30 cities on six continents, how
                the hour, the weather, events nearby and the kind of place move a
                venue’s crowd away from its usual week. For every hour it predicts
                how far the crowd moves and adds that to the usual week, giving a
                busyness score from 0 to 100. Where Flock knows a venue’s usual
                week, the number on its card starts from that score. Until late
                December, the number for a venue Flock read live also moves by
                half of how far its live readings from the last four weeks ran
                above or below that week.
              </p>
              <p>
                We tested it on three cities it never trained on: Miami, Barcelona
                and Tokyo. Its training and test readings are a busyness provider’s
                estimates on that 0 to 100 scale, not head counts. The results are
                in the paper on the <a href="/research">research page</a>.
              </p>
              <p>
                The version serving today, trained in August, is 800 small decision
                trees up to 8 splits deep, each fixing what the trees before it got
                wrong. The next version will learn from live readings taken up to
                November 11. It will take over only if it passes all eight tests of
                a gate fixed in advance, scored on the live readings of November 12
                to 25, which are kept out of its training. It will also be larger:
                2,000 trees up to 10 splits deep, a size picked on November 26 by a
                test on training cities.
              </p>
            </div>
            <Figure
              img={FIGURES.trees}
              sizes={WIDE}
              className="ai-wide"
              alt="Inputs such as the hour, the temperature, rain and events nearby go in. On the chart, the forecast rises above the venue’s usual week toward the peak and runs through the dots that mark what happened. A counter reads 800 of 800 trees, the size of the version serving today, and each tree fixes what the ones before it got wrong. Out comes the usual week plus a correction: busyness for each hour, 0 to 100."
              caption="A schematic of the version serving today, not real readings."
            />
            <div className="ai-pair">
              <Figure
                img={FIGURES.map}
                sizes={HALF}
                alt="A world map of the cities Starling learned from, with Miami, Barcelona and Tokyo circled."
                caption="Miami, Barcelona and Tokyo were held out of training."
              />
              <Figure
                img={FIGURES.code}
                sizes={HALF}
                alt="Code from backend/scripts/ml/train/train_model.py: 800 estimators, minimum child weight 7, maximum depth 8, cross-validation grouped by city, and the forecast clipped to 0 to 100."
                caption="How the version serving today was trained, from the repository."
              />
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper" aria-labelledby="ai-h-estimate">
          <div className="lp-wrap">
            <h2 id="ai-h-estimate">A forecast is a guess, and it says so</h2>
          </div>
          <div className="lp-wrap ai-split">
            <div className="ai-text">
              <p>
                Flock marks the forecast as an estimate. When a venue knows better on
                the night, its owner can set the live number from their dashboard.
                Groups see it credited to the place, like “the cafe says”, and it lasts 90 minutes.
              </p>
            </div>
            <Figure
              img={FIGURES.band}
              sizes="(min-width: 960px) 600px, calc(100vw - 40px)"
              alt="A chart of one evening’s busyness from 6 PM to midnight, the forecast inside a shaded band marked as an estimate. At 9 the venue sets 86, 22 points above the forecast, and its number lasts 90 minutes."
              caption="An illustration of one evening, not real readings."
            />
          </div>
        </section>

        <section className="lp-sec lp-sec-navy lp-on-navy" id="owl" aria-labelledby="ai-h-owl">
          <div className="lp-wrap">
            <h2 id="ai-h-owl">Owl counts people from heat</h2>
            <div className="ai-text">
              <p>
                Owl is a small neural network, 718,550 weights, that runs on
                the Raspberry Pi inside <a href="/flux">Flux</a>, the sensor we’re
                building. It reads a thermal frame and marks each person as a peak of
                warmth. The count leaves the sensor. The frame stays behind.
              </p>
              <p>
                It was trained on generated frames and 28 public thermal datasets,
                then tested on footage it never saw. It hasn’t run in a venue yet.
              </p>
            </div>
            <Figure
              img={FIGURES.pipeline}
              sizes={WIDE}
              className="ai-wide"
              alt="Owl's path through a frame: a 160 by 120 thermal frame goes in, through the network's layers, and out comes a 40 by 30 map where each person is a peak. Here it finds 3 people."
              caption="This thermal frame is generated, not a picture of real people."
            />
            <div className="ai-pair">
              <Figure
                img={FIGURES.owlCode}
                sizes={HALF}
                alt="Code from flock-sensor/main.py: a peak is a cell at least as sure as all eight neighbours, the same rule training scored the model with."
                caption="How a peak becomes a person, in the sensor’s code."
              />
              <Figure
                img={FIGURES.flow}
                sizes={HALF}
                alt="The Flux sensor deletes the frame and sends “count: 3” to the Flock server, never the frame."
                caption="The frame never leaves the box."
              />
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" id="roost" aria-labelledby="ai-h-roost">
          <div className="lp-wrap">
            <h2 id="ai-h-roost">Roost’s advisor checks its numbers against your data</h2>
            {/* Birdie sits level with Roost's words from 960px (his ask,
                2026-10-21: "in line with the roost description"), not in a
                block of its own under the figures. */}
            <div className="ai-roost-top">
              <div className="ai-text">
                <p>
                  Roost is the plan for venues, and its advisor helps an owner make
                  more money: a short answer first, then a few points, with the
                  sources at the end. The model writing it is Google’s Gemini. Numbers
                  about the venue are filled in from its measured data, and a number
                  the model states about the venue on its own is checked against that
                  data. A sentence that fails the check is removed before the owner
                  sees it.
                </p>
                <p>
                  Its advice builds on Roost’s playbook: more than 130 tested moves for
                  filling slow days, pricing, staffing and turning tables, written by
                  us from what experienced operators publish. If the model cannot be
                  reached, Roost still answers from the venue’s own numbers and the
                  playbook.
                </p>
              </div>
              <div className="ai-birdie" id="birdie">
                <h3>And Birdie</h3>
                <p>
                  Birdie is the assistant inside the app, built on Google’s Gemini. It
                  suggests places that fit the group and asks before it does anything
                  for you.
                </p>
              </div>
            </div>
            <Figure
              img={FIGURES.answer}
              sizes={WIDE}
              className="ai-wide"
              alt="A venue owner asks when they peak this week. The answer: Friday is your busiest day, peaking near 7 PM at 92 on our index. Two points follow: the rush builds from 5 PM, so have the second cook on before then; and at $35 a head, 20 more covers that night is $700. Sources: model estimate and the venue’s settings. Friday, 7 PM, 92, 5 PM and $35 are highlighted as coming from the venue’s own data."
              caption="An example answer. The highlighted values come from the venue’s own data."
            />
            <Figure
              img={FIGURES.check}
              sizes={WIDE}
              className="ai-wide"
              alt="Rule one of the advisor’s instructions: “Numbers about this venue come only from the facts.” Beside it, the check in backend/services/advisorAnswer.js: a number about the venue that its data does not back loses its sentence."
              caption="The rule, and the check that enforces it."
            />
          </div>
        </section>

        <section className="lp-cta lp-on-navy" aria-labelledby="ai-h-more">
          <div className="lp-wrap lp-cta-in">
            <div>
              <h2 id="ai-h-more">See how they did</h2>
              <p className="lp-lead ai-more-lead">
                The paper on the research page tests Starling and Owl on data
                neither one trained on, including where they fell short.
              </p>
              <div className="lp-cta-row">
                <a className="lp-btn lp-btn-cream lp-btn-lg" href="/research">Read the research</a>
                <a className="ai-textlink" href="/flux">See Flux</a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <div {...pageInert}>
        <SiteFooter
          variant="landing"
          className="lp-footer"
          brand={(
            <a className="lp-brand" href="/">
              <img src="/marks/logo-64.png?v=2" width="24" height="24" alt="" aria-hidden="true" loading="lazy" style={{ borderRadius: '50%', display: 'block' }} />
              Flock
            </a>
          )}
        />
      </div>
    </div>
  );
}
