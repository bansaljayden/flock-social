# Flock venue sensor

A Raspberry Pi that sits at a venue entrance and reports **how busy the room
is** to the Flock backend, where it becomes the "Live Occupancy" card in the
app and a ground-truth signal for the crowd model.

This is the only part of Flock that runs on hardware, in a building we do not
control, on wifi we do not control, with nobody around to restart it. Every
design choice below follows from that.

> ## Status: two of the three sensors have been read on a Pi. The beam has not.
>
> Read this before you trust anything below. On 2026-09-06 this directory was
> installed on a Raspberry Pi 5, `main.py` ran on the board, and the thermal
> camera and the microphone were read for the first time. Every earlier version
> of this box said nothing here had ever been on hardware. Here is where the
> line falls now.
>
> **Verified on the board:**
>
> - `setup.sh` end to end on a fresh Raspberry Pi OS image, including the
>   service-user detection and the Pi 5 branch. The board was identified from
>   `/proc/device-tree/model` and `RPi.GPIO` was swapped for `rpi-lgpio`, which
>   is the failure that would otherwise have reported 0 doorway crossings for
>   the life of the install.
> - Config load, clock (NTP), and the `--selftest` credential check, accepted
>   by the production backend as a `dry_run` from the Pi over the network. The
>   2026-05-02 curl proof is now a proof about this program too.
> - **The thermal camera, which was the part most likely to be wrong.** Every
>   V4L2 ioctl in `ThermalCamera` was written from datasheets and they work.
>   The Lepton enumerates on `/dev/video0`, opens as raw Y16, and reports
>   radiometric: the PureThermal AGC-node failure this box used to warn about
>   did not happen on this unit. Empty room, room median 20.1C, 0 clusters.
> - **The cluster count, calibrated once.** `THERMAL_BIN` moved from 2 to 4 on
>   the bench, because at bin 2 one standing person at about 3 ft fragmented
>   into 3 clusters and at bin 4 the same person reads 1. What that did to
>   `THERMAL_MIN_CLUSTER` is worked out under Calibration; the short version is
>   that 12 cells now means four times as many pixels as it used to.
> - **The microphone, end to end.** 2026-09-13: the MCP3008 converts, and CH0
>   idles near mid-scale and swings with sound in the room, which is what a
>   working MAX4466 does. Four wires were wrong to get there and all four were
>   the same mistake, counted one row too high: 3.3V sat above VDD, ground sat
>   on VREF and held it at zero, DGND had nothing, and the mic's OUT was in a
>   row above the chip entirely. A VREF at zero is what pinned every channel to
>   1023, because the converter divides by it. Reading it is still not
>   calibrating it; see Calibration.
>
> **The bench found one bug and it is fixed here.** `setup.sh` created
> `/etc/flock-sensor` as root:root 0750 and chowned only the file inside it, so
> the service user had no traverse bit on the directory and could not open its
> own 0600 config. It presents as a missing API key on a box where the key is
> present and correct, which is a bad hour at a venue. The directory is now
> owned by the service group too, and `test_main.py` pins it.
>
> **Not verified:**
>
> - **The IR break-beam, the only sensor that has never been read.** Nothing is
>   wired. `--selftest` reports it NOT DETECTED and the device reports 0
>   crossings. The receiver voltage question below is still open, and getting
>   that one wrong damages the Pi rather than returning a bad number.
> - **The noise figure.** The mic reads. The number it produces is uncalibrated
>   and needs a sound level meter beside a running unit, and until then it is a
>   relative loudness index rather than dB SPL.
> - **The display.** No framebuffer has been drawn into.
> - **Two people at once, and any distance past 10 ft.** Everything measured so
>   far was one person between roughly 3 and 10 ft. A count that has never seen
>   two bodies is not a headcount yet.
> - **The loops.** `--selftest` brings a sensor up and reads it once.
>   `thermal_loop` and `noise_loop` are written to run for months and neither
>   has run for an hour.
> - No `requirements.lock.txt` exists yet. `requirements.txt` produces one
>   "once a unit is verified on real hardware", and the sensors are not all
>   there yet.
> - The pin conflict below is still undecided, so nothing has been built with
>   the cellular HAT and the sensors on the header at the same time.
>
> One class of mistake was pinned before any of this rather than hoped at, and
> it is part of why the camera opened on the first try. V4L2 encodes the size
> of each argument struct into the ioctl request number, so a struct one byte
> off does not give a subtly wrong frame, it gives `ENOTTY` and a camera that
> never opens. `test_main.py` asserts the request numbers and both struct sizes
> against the kernel's documented values, on the developer machine, before
> anyone plugs anything in. That bug was in the first draft of this code and
> the test is what found it.

---

## What it collects (and what it cannot)

Three numbers, every 30 seconds:

| Field | What it is | How it is measured |
|---|---|---|
| `ir_beam_count` | Doorway crossings since the last reading | An infrared beam across the doorway; each break counts once |
| `thermal_headcount` | Warm bodies in the camera's field of view | Heat clusters in a 160×120 thermal grid |
| `noise_db` | Ambient loudness | RMS level from a microphone |

**It counts. It cannot identify anyone.**

- The thermal grid is 19,200 pixels of temperature. It is reduced to a cluster
  count inside `count_thermal_clusters()` and discarded. It is never written to
  disk and never transmitted.

  **Be careful how you say this one, and there are now two cases.** The old
  MLX90640 was 768 pixels, and this section used to argue that a face was "a
  few warm blobs" at that resolution. That argument does not survive the move
  to a 160x120 Lepton: a person in one of these frames is a clear human
  silhouette.

  **On a venue sensor, which is every unit without a screen, no frame leaves
  the function that counts it.** Nothing imports an image library, no file is
  written, and the payload is three integers and cannot carry a picture. That
  is the claim the published policy makes and it is exactly true.

  **On a demo unit, which has a touchscreen, one frame at a time is held in
  memory so the panel can draw it.** See "The thermal view" below. It is still
  never written to disk and never transmitted, and no venue unit can do this,
  because the view requires a framebuffer that a venue box does not have. If a
  demo unit is ever installed somewhere as a venue sensor, set THERMAL_VIEW=0
  and the retention stops.

  One correction worth recording, because this file predicted otherwise.
  `legalPagesMatchCode.test.js` and `test_main.py` were expected to fail on the
  commit that added the view. They did not. They pin imports and file writes,
  not whether a frame is held in memory, so they were never going to catch
  this. The guard that does exist is THERMAL_VIEW_ON requiring a screen, and a
  test that asserts it.
- The microphone's samples become one RMS number every five seconds and are
  discarded. No audio is recorded, buffered or sent. You cannot recover speech
  from a loudness reading taken every 5 seconds.
- There is **no camera, no MAC-address collection, no wifi or Bluetooth probe
  sniffing, no phone detection of any kind.** Nothing that could distinguish
  one person from another is captured.
- No user account, device token or identifier is involved. The backend derives
  the venue from the device row; the Pi does not know or send who is present.

If anyone ever proposes adding wifi probe capture, BLE scanning, camera frames,
or per-person tracking: that is a different product with different law attached
to it, and this README is the place the change has to be argued first.

**This is disclosed, and the disclosure is pinned to this code.** Section 3 of
the published privacy policy, "Venue occupancy sensors"
(`frontend/src/website/PrivacyPolicy.js`), describes all three measurements and
states that no photo, audio, phone or identity is captured. It is checked
against this directory on every frontend test run by
`frontend/src/__tests__/legalPagesMatchCode.test.js`, which reads the push
interval and the thermal grid dimensions out of `main.py` (`THERMAL_COLS,
THERMAL_ROWS`), reads the stored columns out of the ingest route's `INSERT`,
pins the pixel format the device asks V4L2 for as the raw temperature one
rather than the greyscale one, and parses `main.py`'s imports to confirm no
camera, audio or radio library is present. Change what this device measures
and that test goes red on the same commit. It did exactly that when the
sensor changed, which is what it is for.

The one thing to be careful about: it is a promise about a device that has
only been switched on once. As of 2026-09-06 the thermal camera and the
microphone have been brought up on a Pi and the claims above held: no image
library is present, no frame reaches a file, and the payload is three integers.
The beam has never been wired. Before the first venue install, re-read section
3 against the running unit rather than against this file.

---

## Hardware

Buy this list. It is the build plan's, and as of 2026-08-26 the code drives it.

| Part | Connects to | Pi pins |
|---|---|---|
| Raspberry Pi 5, 8GB | | |
| FLIR Lepton 3.5 (radiometric) on a PureThermal 3 breakout | USB | none. This is the whole point of the USB part |
| IR break-beam receiver | GPIO 17 (falling edge, internal pull-up) | signal to pin 11 |
| MCP3008 ADC | SPI bus 0, CE0 | CLK pin 23, DOUT pin 21, DIN pin 19, CS pin 24, VDD+VREF 3V3, AGND+DGND GND |
| MAX4466 microphone | MCP3008 channel 0 | OUT to MCP3008 pin 1, VCC 3V3, GND |
| 7 inch 720×1280 DSI panel, mounted portrait (demo units only) | DSI | ribbon, no header pins |

Two things about that list that are decisions, not details.

**The Lepton must be a 3.5, and it must be radiometric.** A Lepton 3.0 is the
same resolution and does not report absolute temperature, and every threshold
in `count_thermal_clusters` is a temperature. A non-radiometric camera streams
happily and counts nothing real; `main.py --selftest` will tell you which one
you have, and `thermal_loop` reports 0 rather than a made-up number.

**The microphone stays analog, through the ADC.** A USB microphone would be
one cable instead of five wires and it is the wrong trade: it puts a real audio
capture device and an audio library on the box, and "no audio recording" in the
privacy policy is currently backed by the fact that neither exists here. The
MAX4466 into an MCP3008 is load-bearing for that claim.

**Portrait is an OS setting.** `display_loop` asks the framebuffer for 720x1280
and draws into whatever it is given. If the panel comes up landscape, rotate it
in Raspberry Pi OS; the program cannot and does not try to.

> ⚠️ **Confirm with a unit in hand before the first install:** many break-beam
> receivers are 5V parts. The Pi's GPIO is **not** 5V tolerant. Use a receiver
> with an open-collector output pulled up to 3V3, or put a level shifter in
> line. Wiring a 5V signal straight into GPIO 17 will damage the Pi.

### Pi 5

`RPi.GPIO` does not work on a Pi 5. The Pi 5 put GPIO behind the RP1
southbridge, and the original library cannot reach it: the doorway counter
fails at startup and the unit reports 0 crossings for as long as it is
deployed, with a log line about a peripheral base address that explains
nothing. `setup.sh` detects the board and installs `rpi-lgpio` instead, which
provides the same module and API and needs no change to `main.py`. The two
libraries cannot both be installed. `main.py --selftest` prints the board it is
running on as its first line.

### The pin conflict, which is still open

Moving the thermal camera to USB freed the I2C pins (3 and 5), and that is a
real reduction. It did not dissolve the problem, and it is worth being precise
about what is left rather than declaring it solved.

What this code still needs on the 40-pin header:

- **GPIO 17** (pin 11) for the break-beam, plus 3V3 and a ground.
- **SPI0 CE0** for the mic's ADC: pins 19, 21, 23, 24.

What the build plan puts on the same header: a SIM7600 4G HAT, with the note
"single HAT only". A HAT in that form factor physically covers all forty pins
whether or not it electrically uses them, so the conflict is now a **mechanical
one, not a bus one**, and USB did not make it go away.

**Not verified from here:** which pins that specific HAT actually drives. The
Waveshare SIM7600 boards are usually a UART pair plus a power-key line and can
alternatively be run over USB, but nobody has read the datasheet for the exact
board against this pin list, and guessing at it is how a unit gets built twice.

Four ways out, in the order they cost least. **This is the maintainer's call, not the
code's**, and none of them is picked here:

1. **Stacking header.** A 2x20 extra-tall header raises the HAT and leaves the
   pins reachable underneath. Cheapest, no code change. Only works if the HAT
   does not itself use GPIO 17 or SPI0, which is the unverified part above.
2. **Put the modem on USB too.** These HATs generally expose a USB interface
   and can run as a plain USB modem off a cable instead of on the header. The
   header is then completely free and the pass-through question disappears.
   Costs a USB port and its own power; the Pi 5 has four and the Lepton takes
   one.
3. **Cellular only on the demo unit.** Venues have wifi, and the modem is a
   pitch feature rather than a fleet requirement. This confines the problem to
   one box instead of solving it.
4. **Drop the SPI microphone.** Listed for completeness and argued against
   above: the analog mic is what backs the "no audio recording" clause. Do not
   trade it for a USB mic to free four pins.

---

## Provisioning a device

Every device has its own key. A key is scoped to exactly one venue: the Pi
never sends a venue ID, so a device physically cannot report occupancy for
somewhere it is not installed.

**There is no admin UI for this yet.** Today it is SQL against production. See
"Known gaps".

### 1. Mint a key

```bash
KEY=$(openssl rand -hex 32)          # this goes on the Pi
DIGEST="sha256:$(printf '%s' "$KEY" | sha256sum | cut -d' ' -f1)"
echo "device key:  $KEY"
echo "store this:  $DIGEST"
```

Store the **digest** in the database, not the key. A database dump then does
not hand its reader the ability to forge readings for every venue we have
hardware in. The backend accepts either form, so older plaintext rows keep
working, but every new device should be hashed.

### 2. Create the device row

```sql
INSERT INTO sensor_devices (device_id, venue_place_id, api_key, device_name, is_active)
VALUES (
  'sensor_001',                  -- also goes in SENSOR_DEVICE_ID on the Pi
  'ChIJ...',                     -- the venue's Google place_id
  'sha256:<digest from step 1>',
  'The Fox, front door',
  true
);
```

`venue_place_id` must be the same `place_id` the app uses for that venue, or
the readings land on a venue nobody is looking at.

### 3. Put the key on the Pi

Into `/etc/flock-sensor/flock_sensor.env` (mode 0600). Never into the repo,
never into a chat message that outlives the install, never into a screenshot.

### Rotating or revoking a key

Treat every deployed key as compromisable: the Pi is a small computer sitting
in a bar, and anyone who walks off with it can read the SD card.

```sql
-- Revoke. The device stops being accepted immediately and backs off quietly.
UPDATE sensor_devices SET is_active = false WHERE device_id = 'sensor_001';

-- Rotate. Update the row first, then the Pi; it recovers on its own within
-- 30 minutes without a site visit.
UPDATE sensor_devices SET api_key = 'sha256:<new digest>' WHERE device_id = 'sensor_001';
```

---

## Installing

On a fresh Raspberry Pi OS image, with the Pi already on the venue wifi:

```bash
git clone <repo> && cd flock-app/flock-sensor
sudo ./setup.sh
sudo nano /etc/flock-sensor/flock_sensor.env      # set FLOCK_API_KEY + SENSOR_DEVICE_ID
sudo systemctl restart flock-sensor
```

`setup.sh` is safe to re-run and never overwrites an existing config. It works
out which account owns the Pi (Raspberry Pi OS has not shipped a default `pi`
user since 2022), installs the source to `/opt/flock-sensor`, writes the config
at mode 0600, adds the service user to the `video`/`spi`/`gpio` groups, and turns
on NTP.

### Verify before you leave the venue

```bash
sudo -u <service user> python3 /opt/flock-sensor/main.py --selftest
```

It prints every setting, says which of the three sensors it can actually see,
checks the credentials against the real backend, and exits non-zero with a
plain-English reason if anything is wrong. **Do not leave a venue until this
exits 0.**

On a unit with a thermal camera, run `main.py --calibrate` on the same visit,
once the camera is mounted where it will stay. The shipped headcount threshold
was measured in one room, and it is the setting most likely to be wrong for
yours. See Calibration.

The credential check is a `dry_run`: the backend authenticates and validates it
exactly as it would a real push and stores nothing, so running a self test never
writes a fake "0 people" reading into the venue's history or the model's
training data. Stop the service first (`sudo systemctl stop flock-sensor`) if
you want the hardware lines to be meaningful, since the running service holds
the camera, SPI and GPIO devices.

Then watch a couple of real pushes:

```bash
journalctl -u flock-sensor -f
```

You want `Delivered 1 reading(s); 0 still queued` roughly every 30 seconds.

---

## How it behaves when things go wrong

This is the part that matters, because nobody is going to be there.

| Situation | What happens |
|---|---|
| **Wifi drops** | Readings keep being taken on schedule and queue up with their real timestamps. Delivery attempts back off exponentially (30s → 15 min, jittered) instead of hammering. When the network returns, the queue drains oldest-first, a few per cycle. |
| **Backend is down (5xx)** | Same as above. Nothing is lost until the queue passes 240 readings (~2 hours), after which the oldest are dropped. |
| **Outage longer than 2 hours** | The oldest readings are dropped, not the newest. Recent data always survives. |
| **Reboot / power cut** | The queue is written atomically (temp file + rename) and reloaded on boot, so a power cut cannot leave a half-written file. Up to one push interval of in-flight counts is lost. |
| **Clock is wrong** | A Pi has no real-time clock, so it boots in the past. Readings taken before NTP syncs are tagged on the monotonic clock and given their true time once the clock is set. If the clock is still wrong when they are sent, the backend stamps them on arrival rather than accepting a bogus date. |
| **Full or read-only disk** | The queue stays in memory (already capped) and the device keeps reporting. Logs rotate at 5 MB × 4. |
| **Wrong or revoked API key** | The device keeps its queue, logs the reason, and retries on a slowing schedule up to every 30 minutes. Fix the key and everything taken in the meantime still delivers, without a site visit. |
| **Someone points it at an `http://` endpoint** | It refuses to send at all rather than putting the device key on the venue's wifi in the clear, and says so in the log. Set `ALLOW_INSECURE_URL=true` only for a bench backend. |
| **A reading the backend will never accept (400)** | Dropped, with the reason logged. One bad reading is worth losing; re-sending it every 30 seconds forever is not. One exception: "recorded_at is in the future" means the device clock is running fast, and dropping would mean dropping every reading until a human notices, so that one resends undated and the backend files it on arrival. |
| **A sensor fails at startup** | That signal reports 0 and the other two carry on. Repeated read errors are logged once every 5 minutes, not every 2 seconds. |
| **A sensor stops answering mid-shift** | Same: it reports 0, not the last number it read. The thermal count and the noise level are latched values, so without this a bus that locked up at 11pm went on posting 11pm's headcount every 30 seconds, and the venue card showed a packed room at 4am. Thermal goes to 0 after 90 seconds without a good read, the mic after 60. |
| **The thermal camera falls off the USB bus** | It is closed and opened again after about 30 seconds of unusable reads, on a backoff out to 5 minutes, for as long as it takes. Before 2026-09-08 nothing ever re-opened it: one dropout, which a USB device in a bar will have, ended the headcount for the rest of the deployment while the push kept succeeding and the fleet status kept saying online. A camera absent at boot is also retried now, rather than written off. |
| **The backend says slow down (429)** | It waits the interval the backend asks for, which is seconds, and carries on draining. It does not treat this as an outage. |
| **The push thread dies** | It cannot: the cycle is wrapped. If it somehow does, an in-process watchdog exits non-zero and systemd restarts the service. |
| **The display crashes (demo units)** | The process falls through to headless operation instead of exiting cleanly, which systemd would not have restarted. |
| **systemd gives up** | It cannot. `StartLimitIntervalSec=0` disables the "5 fast restarts and stay dead" default, which is the wrong behaviour for a box nobody can reach. |

Duplicate delivery is handled too: a push that succeeded server-side but timed
out on the Pi gets retried, and the backend recognises `(device, recorded_at)`
and returns the original row instead of double-counting the doorway.

---

## Calibration

**Noise.** Out of the box `NOISE_REF_COUNTS=1.0` and `NOISE_DB_OFFSET=50.0` are
nominal, so the reported figure is a **relative loudness index, not calibrated
dB SPL.** To calibrate: put a sound level meter next to the mic, note the real
dB at two very different loudness levels, and adjust `NOISE_DB_OFFSET` until
the reported value matches. Until someone does that on real hardware, do not
present the number to users as a decibel measurement.

**Thermal.** The warm-pixel threshold floats above each frame's own median
(`THERMAL_MARGIN_C`), so a hot room does not turn the whole grid into one giant
"person", which is the failure that used to make a packed bar in August report
a headcount of 1. That design carried over from the old sensor unchanged and
matters more here: a Lepton's absolute accuracy without a calibration target is
several degrees, so `THERMAL_THRESHOLD_C` is closer to a floor than a real
decision and the median-relative margin does nearly all the work.

**`THERMAL_BIN` is 4, and that one was measured.** Bench 2026-09-06,
PureThermal 3 and a Lepton 3.5, indoors, room median 20 to 22C, one adult:

| Condition | Bin 2 | Bin 4 |
|---|---|---|
| Empty room | 0 | 0 |
| One person at about 3 ft, whole body in frame | 3 | 1 |
| One person at 8 to 10 ft, whole body in frame | not run | 1, repeatably |
| One person at 8 to 10 ft, partly cropped at the frame edge | not run | 0 |

The 3-clusters-at-3-ft reading is the fragmentation failure this file had only
predicted, seen for real: a bare head and a covered torso are two warm regions
with a cool band between them, and at bin 2 that band survives pooling. At bin
4 it averages out. That is why the advice below says raise `THERMAL_BIN` before
`THERMAL_MIN_CLUSTER`.

**Changing the bin changed what `THERMAL_MIN_CLUSTER` means, and it was not
retuned.** 12 cells is 48 raw pixels at bin 2 and 192 at bin 4. The derivation
that produced 12 assumed bin 2, so here it is with the arithmetic finished at
bin 4 instead:

- The standard Lepton 3.5 lens is about 57 degrees horizontal, so at distance
  `d` the frame is roughly `1.09 x d` metres wide, and 160 pixels across it is
  about `147 / d` pixels per metre.
- At 3 m that is 49 px/m, so an adult head is very roughly 8 by 11 pixels, call
  it 80 to 120 raw pixels of bare skin. At 5 m it is 30 px/m and the same head
  is 30 to 45.
- Pixels are mean-pooled into `THERMAL_BIN x THERMAL_BIN` cells, so at bin 4
  divide by sixteen rather than four: a head is about 5 to 7 cells at 3 m and
  about 2 at 5 m. **Every one of those is under 12.**
- A whole standing body is not. At 49 px/m an adult is roughly 80 pixels tall
  and 25 across, so even a fraction of that silhouette clearing the warm cutoff
  is hundreds of raw pixels, which is tens of cells at bin 4.

So `THERMAL_MIN_CLUSTER = 12` no longer encodes "a head at doorway range". It
encodes "a body-sized warm region in frame", and the bench is what says that is
the right thing for it to encode: at 8 to 10 ft a whole silhouette counted every
time and a partial crop at the frame edge counted zero. **This device measures
warm area.** It is repeatable at a fixed input. What varied between the early
runs was how much of a body was in frame, not the algorithm.

**Which makes framing a mounting problem, and it is the thing to settle before
the first venue install.** Where the camera sits and how it is angled decides
whether somebody crossing the doorway is whole in frame or clipped by its edge.
Mounted close to a narrow doorway everyone is partly cropped and the count runs
low. Mounted back far enough that a whole body fits, the count is the one that
was measured. Nobody has done this against a real doorway yet.

The two constants are one setting in two variables, so `test_main.py` pins the
pair (4, 12). Move either and re-derive both.

Still unmeasured, and the next two things to run: two people at once, which is
the difference between a count and a headcount, and any distance past 10 ft.

On the bench: run `main.py --selftest`, which prints the cluster count it sees
right now, and walk in and out of frame. Stop the service first or it holds the
camera. If one person reads as several, the silhouette is fragmenting and
`THERMAL_BIN` should go up, and `THERMAL_MIN_CLUSTER` should come down with it:
the two are one setting, the product `min_cluster x bin^2` is the real threshold
in raw pixels, and it wants to stay near the measured 192. Raising the bin alone
past 5 leaves the shipped 12 demanding more warm area than a whole person has,
which counts nobody at all. `validated_thermal_pair` refuses that combination,
falls back to the measured 4 and 12, and says so in the log and in `--selftest`.
If an empty room
reads as one or more people, raise `THERMAL_MARGIN_C` first, then
`THERMAL_MIN_CLUSTER`.

**The threshold has two arms and only one of them has ever run.** This is the
largest open question about this sensor, it was found by three independent
research passes on 2026-09-08 that each arrived at it from a different
direction, and it is not settled here because settling it needs a measurement.

The cutoff is `max(THERMAL_THRESHOLD_C, median + THERMAL_MARGIN_C)`. At the
shipped 28.0 and 3.0 the median-relative arm only wins once the room is above
25C. The bench room was 20.1C, so **every result this sensor has ever produced
came from the fixed 28.0C arm**, and the docstring claiming the margin "does
nearly all the work" is backwards for any room below 25C, which is most rooms
and nearly every doorway.

That matters because of what an absolute temperature is worth here. The Lepton
Engineering Datasheet's own accuracy table gives **±7C at a 10C scene**,
uncalibrated, and that is the row a 20C room and a 27C clothed torso sit in.
Per-unit calibration against two blackbodies only brings it to ±5C, an
enclosure window makes it worse, and published measurements on this exact part
show a step in absolute temperature across every flat field correction plus
about a minute of settling afterwards, with FFC firing every three minutes by
default. So the question the sensor actually asks a venue is "is this pixel
above 28C", asked by an instrument that may be seven degrees off, differently
per unit, and that moves after every shutter event.

Reproduced here, against the real counter:

| Scene | What a venue sees |
|---|---|
| 14C vestibule, two clothed bodies at 25 to 27C apparent | **0** |
| Same, bodies at 28C apparent | 2 |
| Room where people fill more than about half the frame | **0**, because the median becomes body temperature and the cutoff climbs above it |

A median-relative cutoff is immune to a constant radiometric offset. A fixed
one is not. The design already in this file is the right one; it is sitting
behind a `max()` that stops it from ever running.

**What to do about it, in order.** Run `main.py --calibrate`. It now measures
the margin as well as the cluster size: it reports how far above the room
median the warmest thing in an empty frame gets, how far above it a real person
gets, recommends a `THERMAL_MARGIN_C` between them, and **tells you whether the
fixed floor will override the number it just measured at your room's
temperature**. At a 20C room with a 5C margin it says, in as many words, that
`THERMAL_THRESHOLD_C=28.0` makes the measurement decorative. Then lower
`THERMAL_THRESHOLD_C` below the cutoff it names, so the margin becomes the arm
that decides.

That default has not been changed here. Doing it from a desk would be swapping
one unmeasured number for another, which is the thing this file exists to stop.
It wants one bench session: a person at the far edge of the crossing, in a room
at a normal temperature, with `--calibrate` running.

**Lowering the minimum to reach farther does not work the way it looks like it
should.** A silhouette's area falls with the square of distance, so range goes
as `sqrt(current / new)`:

| `THERMAL_MIN_CLUSTER` | Raw pixels at bin 4 | Range against 12 |
|---|---|---|
| 12 | 192 | 1.00x |
| 11 | 176 | 1.04x |
| 10 | 160 | 1.10x |
| 8 | 128 | 1.22x |
| 6 | 96 | 1.41x |
| 5 | 80 | 1.55x |

12 to 11 buys about 4%, which at 10 ft is five inches. Buying a useful amount
of range means roughly halving the number, and 5 is where this sensor's own
noise starts being counted as people. That is the failure the 24x32 default of
4 produced, and the reason `test_main.py` pins the minimum above 4. When the
count has to reach farther than the setting allows, the lever is where the
camera is mounted rather than this number.

**`main.py --calibrate` measures the number for the room it is actually in.**
The shipped 12 is one number from one bench in one room. What it should be
depends on how far the camera sits from the crossing and how warm the room
runs. Mount the unit where it is going to live, then:

    sudo systemctl stop flock-sensor
    sudo -u <service user> python3 /opt/flock-sensor/main.py --calibrate

It watches an empty frame for twenty seconds to find how large this room's warm
noise gets, then watches somebody standing at the farthest point a person
actually crosses, and prints a `THERMAL_MIN_CLUSTER` sitting between the two
along with both measurements. `--seconds` changes the window. It writes
nothing: paste the line into the config, restart, and walk the doorway again.

When the two overlap it recommends nothing and says why, which is the answer
worth having. A person who is no larger than the room's own noise cannot be
separated from it by any threshold, and the camera has to move instead.

**It does not adjust itself while the service runs, and that is deliberate.** A
threshold that moved on its own would have to tell "a distant person" from
"sensor noise" out of identical evidence, and the version that lowers itself
when it sees nothing converges on inventing people in an empty room. These
readings are also ground truth for the crowd model, so a venue whose definition
of a person drifts week to week poisons the training data quietly and nothing
downstream can tell. The adjustment happens once, at install, with somebody
standing in the room to say which reading is which.
**A warm fixture in frame was a permanent person, and now it is not.** A
radiator, a kitchen pass, a heat lamp, a television, an espresso machine or a
patch of floor the sun reaches is warm in every single frame. Nothing that looks
at one frame at a time can tell that from a person standing very still, so it
added a constant +1 or +2 to that venue's headcount forever, including at 4am
with the doors locked. Measured on the real counter: one 40x60-pixel fixture at
32C in a 20C room counts as 1 person with nobody there, and turns 3 people into
4.

`SceneBackground` learns the room per cell over time instead. What it models is
the residual, the cell minus the frame's own background estimate, so it is
immune to slow ambient drift and to the offset step the Lepton leaves after
every flat field correction. It seeds for about a minute on the per-cell
*minimum* residual, so somebody who walks through the seed window never becomes
furniture, then decays with a time constant of roughly seventeen minutes.

Three properties are worth knowing, and all three are pinned by tests:

- **It can only subtract.** A cell has to clear the old cutoff AND be warmer
  than the scene usually is. A background model that has gone wrong therefore
  loses a person; it cannot invent one. That asymmetry is deliberate, and it is
  what makes this safe to leave running unattended.
- **It reports nothing while seeding**, which is a different claim from zero,
  and the loop leaves the freshness clock alone so the device says "no reading"
  rather than "nobody here".
- **A motionless person is not absorbed.** Cells currently held to be people
  learn at a twentieth of the normal rate, so somebody who stands still for two
  hours is still counted. This is the classic failure of background subtraction
  and it is the one thing this design spends complexity on.

The cost, measured: if somebody stands perfectly still through the whole seed
window they are learned as furniture and leave a blind spot. It heals within
about five minutes of the room actually being empty, and the rest of the frame
keeps counting normally in the meantime. Seeding happens at start-up and again
after the camera is re-opened, so an install where somebody loiters in view at
boot is worth avoiding.

**One thing here needs a human decision rather than a passing test suite.** The
published privacy policy says the thermal grid is reduced to a count and thrown
away. This holds 1,200 numbers in RAM: a 4x4-pooled, low-pass-filtered residual
of a static scene. It is never written to disk, never transmitted, and at that
pooling it is not a recognisable image of anything; the raw 19,200-pixel frame
this program already holds transiently is strictly more revealing. The wording
still deserves a read before the first venue install, because
`legalPagesMatchCode.test.js` pins the policy by parsing imports and will not
fire on this either way.

**Fragmentation is the failure mode the old sensor did not have**, and it is
now the one that has actually been seen. On a 24x32 grid a whole person was a
handful of pixels and blurred into a single blob. At 160x120 a bare head and a
clothed torso are two warm regions with a cool band across them, and a naive
count reports two or three people, which is exactly what bin 2 did at 3 ft. The
code answers that with mean-pooling and eight-connectivity, where a diagonal
touch joins two regions. Coarser pooling cuts both ways and that is worth
knowing: at bin 4 two regions have to be closer in raw pixels before they join
at all, which is why `test_main.py` had to move a fixture that only touched on
the finer grid.

**IR beam.** `ir_beam_count` is **crossings, not entries**: it counts a break in
either direction, so a doorway used both ways roughly doubles the true entry
count, and someone loitering in the beam inflates it further. Anything built on
this field has to treat it as a relative activity signal.

---

## Pinning

`requirements.txt` is not version-locked. A Pi flashed in two years gets
whatever pip resolves that day, which is a real way for a fleet to break. Once
a unit is verified on hardware:

```bash
pip3 freeze > requirements.lock.txt   # on the verified unit
```

Commit it and have `setup.sh` install from it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `--selftest` says `api key: MISSING` | Config not filled in | Edit `/etc/flock-sensor/flock_sensor.env` |
| `refused (HTTP 401)` | Wrong key, or the digest in the DB does not match | Re-mint and re-provision |
| `refused (HTTP 403)` + `device_id does not match` | This Pi has another venue's key | Fix `SENSOR_DEVICE_ID`, or the key is genuinely the wrong one |
| `refused (HTTP 403)` + `Device deactivated` | `is_active = false` | Re-activate the row |
| `no reply` | Venue firewall or captive portal | Outbound HTTPS on 443 must be allowed; captive portals need the Pi's MAC allowlisted by the venue |
| `certificate is not yet valid` | Clock unset and no NTP | Check internet access; `timedatectl set-ntp true` |
| Service works by hand, fails under systemd | Missing hardware group membership | `sudo adduser <user> video` (also `spi`, `gpio`) then reboot |
| Headcount stuck at 0, log says the node does not exist | Camera not enumerated | `v4l2-ctl --list-devices`; check the USB cable, then set `THERMAL_DEVICE` if it came up somewhere other than `/dev/video0` |
| Headcount stuck at 0, log says "not radiometric" | The AGC video node, or a non-radiometric Lepton | `v4l2-ctl -d /dev/videoN --list-formats` and use the node offering `Y16`. A Lepton 3.0 cannot do this at all; it has to be a 3.5 |
| Headcount stuck at 0, log says "would not give a raw Y16 stream" | Same as above, caught at open time | Same fix |
| Headcount stuck at 0, no thermal log lines at all | Service user not in the `video` group | `sudo adduser <user> video`, then reboot |
| One person counted as two or three | Silhouette fragmenting at 160x120 | Raise `THERMAL_BIN` to 3 or 4. See Calibration |
| Headcount stuck at 1 in a busy room | Ambient too warm | Raise `THERMAL_MARGIN_C` |
| An empty room reports several people | `THERMAL_MIN_CLUSTER` too low for this mounting distance | Raise it. The default is derived, not measured |
| Crossings stuck at 0, `--selftest` says the board is a Pi 5 | `RPi.GPIO` cannot drive Pi 5 GPIO | `sudo pip3 uninstall RPi.GPIO && sudo pip3 install --break-system-packages rpi-lgpio`, then restart |
| Crossings stuck at 0 | Beam misaligned or receiver unpowered | Break the beam by hand and watch the log |
| `has not read successfully for over 90s` in the log | A sensor answered once and then stopped: a USB camera that dropped off the bus, or a locked SPI bus | The device is reporting 0 for that signal on purpose. Reseat the USB cable or the wiring; a reboot clears a wedged bus |
| `--selftest` says READING NOTHING USEFUL, every sample 1023 | VREF has no power. The converter divides by VREF, so zero there pins every channel to full scale | Check VREF and VDD both reach 3.3V. They are the two pins at the notch end of the chip |
| Same, every sample 0 | No ground, or the chip is never selected | Check AGND and DGND both reach ground, and that CS reaches CE0 |
| Same, every sample identical at some middling value | The converter has stopped converting. A live mic jitters a count or two even in silence | Reseat the chip; check CLK reaches SCK |
| Same, the mic idles far from 512 | OUT is not reaching CH0, or the mic has no power | OUT goes in the row of the chip's pin 1 corner, on the opposite side of the board from the power pins. VCC on 3.3V, never 5V |
| All eight channels return the same numbers | The chip is not selecting channels | CS to CE0, CLK to SCK |
| Everything above at once, on a first build | Almost always one mistake repeated: the wires counted from the wrong row | Find the row the chip's notch end sits in and number down from there. Pin 1 is that row on the left side; pin 16 is that row on the right |

---

## Is a deployed unit alive?

`GET /api/sensors/:placeId/status`, authenticated, and only for the account that
owns that venue's profile. It returns one row per device at that venue:

```json
{ "devices": [{ "device_id": "sensor_001", "device_name": "The Fox, front door",
                "is_active": true, "last_seen_at": "2026-08-25T21:40:12.881Z",
                "seconds_since_last_seen": 18, "online": true }],
  "online_within_minutes": 15 }
```

`online` uses the same 15-minute window the app's occupancy card uses, so the
two can never disagree. A device that has never reported has a null
`last_seen_at`, which is a different thing from one that has gone quiet, and
both are distinguishable from a row with `is_active: false`.

**Nothing renders this yet.** Both occupancy cards in `App.js` draw only when
`/current` returns a row, so today a unit that dies does not appear as broken,
the section simply stops existing and the owner is told nothing. The endpoint is
the half of that fix that lives in this project. Wiring it into the venue
dashboard as an offline state is a frontend change and is listed under Known
gaps.

Nothing alerts on it either. Checking it is still a thing a person has to
decide to do.

---

---

## The thermal view

On a unit with a screen, tap the panel and it shows what the camera is looking
at: the room in false colour, the count, and the warmest point in frame. Tap
again to go back. This is step 6 of the pitch demo and it is the moment that
makes an invisible sensor legible to somebody watching.

It is the only place in this program that turns a frame into a picture, so it is
fenced:

- `THERMAL_VIEW_ON` requires **both** `THERMAL_VIEW=1` and a physical screen. A
  venue sensor is headless, so it retains no frame whatever its config says, and
  the published promise about venue sensors stays exactly true.
- The frame is held in memory only. It is never written to disk and never
  transmitted; the push payload is three integers and has nowhere to put one.
- The picture carries the sentence "Temperatures only. Nothing here is recorded
  or sent." A thermal image of a room reads as a camera to most people, and this
  is the one screen in the product where that misreading is easy to make.

Turn it off with `THERMAL_VIEW=0`, which is what to do if a unit that has a
panel is ever installed at a venue.

**How it draws.** The palette is stretched between the 2nd and 98th percentile
of the frame rather than min and max, so one stuck pixel cannot wash the picture
out and a hand entering frame visibly takes the top of the scale. The span has a
4C floor, which stops a nearly uniform room being amplified into dramatic
looking noise: sensor noise presented to a judge as structure would be a lie.
160x120 is smoothscaled up to the panel, which is what makes it read as thermal
imagery rather than a grid of squares.

## Known gaps

Things that are still open, so nobody has to rediscover them.

1. **The beam has never been read, and no sensor has run for longer than a
   selftest.** As of 2026-09-06 `setup.sh`, the config load, the clock, the
   backend credential check, the thermal camera and the microphone are all
   verified on a Pi 5. The IR break-beam is not wired at all, the display has
   never drawn, and `thermal_loop` and `noise_loop` have never run a shift. See
   the status box at the top.
2. **No provisioning UI.** Creating, rotating and revoking a device key is
   hand-written SQL against production. That is a mistake waiting to happen
   (wrong `place_id`, plaintext key pasted somewhere) and should become an
   admin endpoint.
3. **The key is recoverable from the device.** Anyone who takes the SD card
   gets a credential that can post readings for that venue until it is revoked.
   The backend clamps every value it accepts, so the blast radius is "plausible
   but wrong numbers for one venue", not arbitrary data. Closing this properly
   needs hardware-backed keys (a TPM or a secure element), which is a hardware
   decision, not a code one.
4. **`noise_db` is uncalibrated** (see Calibration) and is still stored in a
   column called `noise_db`, ~~and printed to users as a decibel figure~~.
   **The user-facing half of this is closed as of 2026-08-26** and the entry
   stays because the column name still lies. The Live Occupancy card used to
   render `· {noiseDb.toFixed(0)} dB` beside the word
   Quiet/Moderate/Lively/Loud; the figure is gone and the word remains, which
   was exactly the fix this gap asked for. No `dB` string is rendered anywhere
   in the app now. The number still drives which of the four words is chosen,
   so a calibration pass would still change what users read, and nobody has yet
   held a sound level meter next to one of these microphones. Do not put the
   figure back until someone has. This device's own display already says
   "level", not "dB".
5. **`ir_beam_count` is crossings, not entries**, but the backend's history
   endpoint sums it as "entries per hour" and `RETRAIN.md` lists it as high
   quality ground truth.
6. **Dependencies are unpinned** (see Pinning).
7. **Fleet health has a read but no reader.** `GET /:placeId/status` exists (see
   "Is a deployed unit alive?"), and nothing calls it. The venue dashboard
   should show an offline state built from it instead of hiding the whole
   occupancy section when a unit stops reporting, and something should alert
   when a device that was reporting stops.
8. **The demo unit's thermal view exists, and has never been drawn.** Step 6 of
   the pitch choreography, "tap the touchscreen, see the heat signature of the
   hand", is built: `draw_thermal_view` plus a tap handler in `display_loop`.
   The conversion from frame to pixels is pure and tested, and the draw path is
   exercised against a stub, but no part of `display_loop` has ever run on a
   framebuffer, so the first time this meets a real panel expect the layout to
   be wrong somewhere. The touch event is the other unknown: a DSI panel may
   report MOUSEBUTTONDOWN or FINGERDOWN depending on the driver, and both are
   accepted for that reason.
9. **The pin conflict is unresolved.** Moving thermal to USB freed I2C but a
   40-pin cellular HAT still covers the pins the break-beam and the mic's ADC
   need. See "The pin conflict, which is still open". the maintainer's decision, and it
   blocks ordering the modem, not the sensors.
10. **The Lepton path is executed but barely exercised.** Every V4L2 ioctl in
   `ThermalCamera` was written from documentation, and on 2026-09-06 they all
   worked on the first board: the camera enumerates, opens raw Y16, reports
   radiometric, and counts an empty room as 0. What that run did not touch is
   the shutter path over a long session, a second unit with different
   PureThermal firmware, and more than one person in frame. The cluster
   thresholds are calibrated against exactly one body at two distances. See
   Calibration.
