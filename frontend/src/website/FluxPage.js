import React, { useEffect } from 'react';
import './LandingPage.css';
import './FluxPage.css';
import SiteFooter from './SiteFooter';
import SiteNav, { useSiteMenu } from './SiteNav';
import FluxViewer from './flux/FluxViewer';
import { shareThisPage } from './shareCard';

// /flux: the people counter Flock is building for venues. What it measures,
// how Owl counts, the case part by part (the labelled render, then the 3D
// model on one slider), a mockup of the inside, and where it goes. Built on
// the landing page's stylesheet like /how-it-works.
//
// What the page may say comes from the sensor work's own list (2026-10-21)
// and the claims ledger (competitions/_shared/claims.md):
//   Pi 5, Lepton 3.5, a doorway distance sensor, a microphone    C-111
//   the doorway sensor is wired and reading; not tested on real walkers
//   noise is a relative level from the mic; the dB meter isn't fitted C-118
//   Owl runs on the Pi; not yet run in a venue                  C-112 (out of date)
//   Owl's training data: generated frames and six public sets      models/NOTICE.md
//   counts every 30 s over Wi-Fi or Ethernet; no images, video or
//   identities leave the box; the case is a design, not printed    sensor work
// Tables (the tables work, 2026-10-23): one box over the door sees most of a
// dining room, never every table; states free, seated (timer from sit-down),
// needs a server (nobody by in 5 minutes), needs clearing; the venue's Tables
// tab with alerts; worked out on the box, only table number, head count,
// state and duration leave; table spots can be learned from where people sit.
// The room picture is generated heat and the tab shots use demo data, and
// the captions say so. No colour camera is mentioned: not built or approved.
// No accuracy figure appears here (they are on /research, with their
// limits), nothing says the 4G board works, and nothing gives a battery life.

const DESCRIPTION = 'Flux is the people counter Flock is building for venues. See what is inside it, how its Owl model counts people from heat, how it reads tables, where it mounts and every part of the case.';

// Every picture on the page, at the two widths each file was written at
// (scripts/flux_assets.py, the tables pictures with --tables-src; the mockup and the figures from /ai by hand).
// fluxPages.test.js checks each file exists at the width it claims.
export const IMAGES = {
  hero: { base: '/sensor/flux-hero', one: 560, two: 1120, height: 419 },
  exploded: { base: '/sensor/flux-exploded', one: 1100, two: 2200, height: 733 },
  mockup: { base: '/sensor/flux-inside-mockup', one: 700, two: 1400, height: 524 },
  inside: { base: '/sensor/flux-inside', one: 520, two: 1040, height: 390 },
  arm: { base: '/sensor/flux-arm', one: 520, two: 1040, height: 390 },
  back: { base: '/sensor/flux-back', one: 520, two: 1040, height: 390 },
  pipeline: { base: '/ai-figures/owl-pipeline', one: 1100, two: 2200, height: 249 },
  flow: { base: '/ai-figures/owl-flow', one: 640, two: 1280, height: 107 },
  tablesIllustration: { base: '/sensor/flux-tables-illustration', one: 640, two: 1280, height: 480 },
  tablesRoom: { base: '/sensor/flux-tables-room', one: 640, two: 1280, height: 480 },
  tablesDesktop: { base: '/sensor/tables-tab-desktop', one: 1080, two: 2160, height: 619 },
  tablesPhone: { base: '/sensor/tables-tab-phone', one: 260, two: 520, height: 679 },
};

function Pic({ img, sizes, alt, eager = false }) {
  const set = (ext) => `${img.base}.${ext} ${img.one}w, ${img.base}@2x.${ext} ${img.two}w`;
  return (
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
  );
}

const SENSORS = [
  {
    name: 'Thermal camera',
    what: 'A FLIR Lepton 3.5. It sees heat, 160 by 120 points of it. Owl, further down, is the model that counts the people in those frames.',
  },
  {
    name: 'Door counter',
    what: 'A VL53L8CX, which measures distance in an 8 by 8 grid. It looks down at a doorway from under the case to count people walking in and out. It’s wired up and reading, but it hasn’t been tested on people walking through a real doorway yet.',
  },
  {
    name: 'Sound meter',
    what: 'A small decibel meter, already bought and built into the case design, measures how loud the room is. Until it’s plugged in, the working unit uses a microphone that gives a rough louder-or-quieter level.',
  },
  {
    name: 'Screen',
    what: 'A 7 inch touchscreen on the front shows the live readings.',
  },
  {
    name: 'Raspberry Pi 5',
    what: 'The computer inside, with an Active Cooler on top.',
  },
];

export default function FluxPage() {
  const menu = useSiteMenu();
  const pageInert = menu.menuOpen ? { inert: true } : {};

  useEffect(() => {
    document.title = 'Flux, the people counter | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
    return shareThisPage('/flux');
  }, []);

  return (
    <div className="lp fx">
      <a className="lp-skip" href="#fx-main">Skip to the main content</a>

      <SiteNav menu={menu} current="/flux" />

      <main id="fx-main" tabIndex={-1} {...pageInert}>
        <section className="lp-sec lp-sec-paper fx-hero" aria-labelledby="fx-h1">
          <div className="lp-wrap fx-hero-in">
            <div className="fx-hero-copy">
              <h1 id="fx-h1">Flux</h1>
              <p className="lp-lead fx-lead">
                A box for a venue’s counter or doorway that counts the people in
                the room and sends Flock the numbers.
              </p>
              <p className="fx-proto">
                <strong>It’s a prototype.</strong> The case on this page is a 3D
                design and hasn’t been printed yet.
              </p>
            </div>
            {/* The page's largest paint, so it is not lazy and goes first. */}
            <figure className="fx-hero-fig">
              <div className="fx-plate">
                <Pic
                  img={IMAGES.hero}
                  sizes="(min-width: 960px) 560px, calc(100vw - 40px)"
                  alt="A render of Flux: a navy box with a 7 inch screen, a cream sensor pill and the Flux wordmark, leaning back on a cream stand."
                  eager
                />
              </div>
              <figcaption className="lp-fig-cap">On its stand, rendered from the CAD.</figcaption>
            </figure>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="fx-h-measure">
          <div className="lp-wrap">
            <h2 id="fx-h-measure">What’s inside it</h2>
            <dl className="fx-sensors">
              {SENSORS.map((s) => (
                <div key={s.name}>
                  <dt>{s.name}</dt>
                  <dd>{s.what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="lp-sec lp-sec-navy lp-on-navy" aria-labelledby="fx-h-owl">
          <div className="lp-wrap">
            <div className="fx-owl">
              <div className="fx-measure">
                <h2 id="fx-h-owl">Owl does the counting</h2>
                <p>
                  Owl is a small neural network we trained to count people from
                  heat. It runs on the Raspberry Pi inside Flux, so each frame is
                  counted on the box that took it.
                </p>
                <p>
                  It reads one thermal frame at a time and marks each person as a
                  peak of warmth. Only the count moves on. The frame never leaves
                  the box.
                </p>
                <p>
                  We trained it on generated thermal frames and six public thermal
                  datasets, never on anything a Flux unit recorded, then tested it
                  on footage it had never seen. It hasn’t run in a venue yet. The
                  results are on the <a href="/research">research page</a>.
                </p>
              </div>
              {/* A painted barn owl on a tree whose twigs fork in layers with a
                  berry at each fork: the network, drawn as a tree. Decoration,
                  so it makes no claim; the figure below is Owl's real path. */}
              <img
                className="lp-art fx-owl-art"
                src="/art/owl-tree-260.webp"
                srcSet="/art/owl-tree-260.webp 260w, /art/owl-tree-520.webp 520w"
                sizes="(min-width: 960px) 260px, 190px"
                width="260" height="531"
                loading="lazy" decoding="async"
                alt=""
              />
            </div>
            <figure className="fx-figure fx-wide">
              <div className="fx-plate fx-plate-paper">
                <Pic
                  img={IMAGES.pipeline}
                  sizes="(min-width: 1160px) 1080px, calc(100vw - 40px)"
                  alt="Owl's path through a frame: a 160 by 120 thermal frame goes in, through the network's layers (718,550 weights), and out comes a 40 by 30 map where each person is a peak. Here it finds 3 people."
                />
              </div>
              <figcaption className="lp-fig-cap">
                One frame through Owl. This frame is generated, not a picture of
                real people.
              </figcaption>
            </figure>
            <div className="fx-sends">
              <div className="fx-measure">
                <h3>What leaves the box</h3>
                <p>
                  Every 30 seconds Flux is built to send a few numbers over Wi-Fi
                  or Ethernet: the people it counts, door crossings, an estimate of
                  how full the room is, and the noise level. A unit set up for
                  tables also sends, for each table, how many people are at it and
                  whether it is free, seated, needs a server or needs clearing. No images,
                  video or identities leave it.
                </p>
              </div>
              <figure className="fx-figure fx-flow">
                <div className="fx-plate fx-plate-paper">
                  <Pic
                    img={IMAGES.flow}
                    sizes="(min-width: 960px) 520px, calc(100vw - 40px)"
                    alt="The Flux sensor deletes the frame and sends only “count: 3” to the Flock server."
                  />
                </div>
              </figure>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="fx-h-tables">
          <div className="lp-wrap">
            <div className="fx-tables">
              <div className="fx-measure">
                <h2 id="fx-h-tables">Tables</h2>
                <p>
                  One box on the ceiling above the door looks down on most of a
                  dining room. Each table in view is free, seated, needs a server
                  or needs clearing. A seated table carries a timer from when the
                  party sat down, and it needs a server when nobody has come by in
                  5 minutes.
                </p>
                <p>
                  The venue sees every table on a Tables tab, with an alert when
                  one needs a server or clearing. It’s all worked out from heat on
                  the box. What leaves is each table’s number, head count, state
                  and how long it has been that way.
                </p>
                <p>
                  Flux can learn where the tables are from where people sit, so
                  nobody has to draw them in.
                </p>
              </div>
              <figure className="fx-figure">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.tablesIllustration}
                    sizes="(min-width: 960px) 520px, calc(100vw - 40px)"
                    alt="An illustration of a dining room seen from above the door, with faceless figures at eight tables. Each table is outlined in its state's colour with a label, and a side panel lists three of eight tables free and two alerts."
                  />
                </div>
                <figcaption className="lp-fig-cap">
                  An illustration of the idea. Flux sees people only as heat and
                  never films them.
                </figcaption>
              </figure>
              <figure className="fx-figure">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.tablesRoom}
                    sizes="(min-width: 960px) 520px, calc(100vw - 40px)"
                    alt="A dining room in generated heat, seen from above the door, with eight tables outlined. Each has a label: free and for how long, seated with a timer and a head count, one needing a server, one needing clearing."
                  />
                </div>
                <figcaption className="lp-fig-cap">
                  What Flux actually sees, made from generated heat with no real
                  people. White dots are the people Owl found.
                </figcaption>
              </figure>
            </div>
            <div className="fx-tabs">
              <figure className="fx-figure">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.tablesDesktop}
                    sizes="(min-width: 1160px) 760px, (min-width: 760px) calc(100vw - 340px), calc(100vw - 40px)"
                    alt="The Tables tab on a computer: 3 of 8 tables free, two alerts at the top for a table waiting on a server and one needing clearing, a card for each table, and a chart of tables in use by hour."
                  />
                </div>
                <figcaption className="lp-fig-cap">
                  The Tables tab on the venue dashboard, with demo data.
                </figcaption>
              </figure>
              <figure className="fx-figure fx-phone">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.tablesPhone}
                    sizes="260px"
                    alt="The same Tables tab on a phone, with the table cards two to a row."
                  />
                </div>
                <figcaption className="lp-fig-cap">The same tab on a phone.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-paper" aria-labelledby="fx-h-parts">
          <div className="lp-wrap">
            <h2 id="fx-h-parts">In parts</h2>
            <p className="lp-lead fx-sub">
              Front to back, in the order it goes together.
            </p>
            <figure className="fx-figure">
              <a className="fx-plate fx-zoom" href="/sensor/flux-exploded@2x.webp">
                <Pic
                  img={IMAGES.exploded}
                  sizes="(min-width: 1160px) 1080px, calc(100vw - 40px)"
                  alt="Every part of the Flux case pulled apart and named, front to back: the cream sensor pill, with the thermal camera and status light behind it, and the Flux wordmark; the printed navy body with the door counter in its chin; the sound meter and 4G antenna to one side; the 7 inch touchscreen; the battery; the 4G board, Active Cooler, Raspberry Pi 5 and power board; and the navy acrylic back sheet with its CHARGE, USB and Ethernet ports."
                />
              </a>
              <figcaption className="lp-fig-cap">
                Rendered from the CAD. <a href="/sensor/flux-exploded@2x.webp">Open it full size</a> to
                read every name.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="fx-h-build">
          <div className="lp-wrap">
            <h2 id="fx-h-build">Put it together</h2>
            <p className="lp-lead fx-sub">
              Slide the bar and the parts come together into the finished box.
            </p>
            <FluxViewer />
          </div>
        </section>

        <section className="lp-sec lp-sec-paper" aria-labelledby="fx-h-inside">
          <div className="lp-wrap">
            <h2 id="fx-h-inside">With the back off</h2>
            <p className="lp-lead fx-sub">
              The battery stands on its end behind the screen, and the Raspberry
              Pi and its cooler are cabled to the ports.
            </p>
            <div className="fx-inside">
              <figure className="fx-figure">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.mockup}
                    sizes="(min-width: 960px) 640px, calc(100vw - 40px)"
                    alt="A mockup of the planned Flux build with its back sheet off: the back of the 7 inch screen, the battery standing on its end, the Raspberry Pi 5 with its cooler fan, the ports along the top and orange power cables between them."
                  />
                </div>
                <figcaption className="lp-fig-cap">
                  A mockup of the planned build, made from the CAD.
                </figcaption>
              </figure>
              <figure className="fx-figure">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.inside}
                    sizes="(min-width: 960px) 360px, calc(100vw - 40px)"
                    alt="The same view in the CAD: the Flux body from behind with the back sheet off, with the screen, battery, Raspberry Pi and cables in view."
                  />
                </div>
                <figcaption className="lp-fig-cap">The same view in the CAD.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-sec-sand" aria-labelledby="fx-h-where">
          <div className="lp-wrap">
            <h2 id="fx-h-where">Where it goes</h2>
            <div className="fx-where">
              <div>
                <h3>On a counter</h3>
                <p>It leans back 12 degrees on its cream stand, screen to the room.</p>
                <h3>Over a door</h3>
                <p>
                  A camera arm tilts it 15 degrees down, and the door counter looks
                  65 degrees down at the floor of the doorway.
                </p>
                <h3>Power and ports</h3>
                <p>
                  A battery inside runs it through a USB-C power board and charges
                  through the CHARGE port. Ethernet and USB are on the back too.
                </p>
              </div>
              <figure className="fx-figure">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.arm}
                    sizes="(min-width: 960px) 420px, calc(100vw - 40px)"
                    alt="Flux on a black camera arm, tilted down from a wall."
                  />
                </div>
                <figcaption className="lp-fig-cap">On the arm, over a door.</figcaption>
              </figure>
              <figure className="fx-figure">
                <div className="fx-plate">
                  <Pic
                    img={IMAGES.back}
                    sizes="(min-width: 960px) 420px, calc(100vw - 40px)"
                    alt="The back of Flux: a navy sheet with the Ethernet, USB and CHARGE ports along the top, two vent grilles and the Flux wordmark."
                  />
                </div>
                <figcaption className="lp-fig-cap">The back, with its three ports.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="lp-cta lp-on-navy" aria-labelledby="fx-h-more">
          <div className="lp-wrap lp-cta-in">
            <div>
              <h2 id="fx-h-more">The models behind it</h2>
              <p className="lp-lead fx-more-lead">
                Owl is one of four models in Flock. One page covers all of them.
              </p>
              <div className="lp-cta-row">
                <a className="lp-btn lp-btn-cream lp-btn-lg" href="/ai">How the AI works</a>
                <a className="fx-textlink" href="/research">Read the research</a>
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
