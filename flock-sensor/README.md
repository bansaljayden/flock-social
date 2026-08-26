# Flock venue sensor

A Raspberry Pi that sits at a venue entrance and reports **how busy the room
is** to the Flock backend, where it becomes the "Live Occupancy" card in the
app and a ground-truth signal for the crowd model.

This is the only part of Flock that runs on hardware, in a building we do not
control, on wifi we do not control, with nobody around to restart it. Every
design choice below follows from that.

> ## Status: this has never run on a Raspberry Pi
>
> Read this before you trust anything below. As of 2026-08-26, `main.py` has
> only ever been executed by `test_main.py` on a developer laptop. Nothing in
> this directory has been on a board. The evidence, so nobody has to re-derive
> it:
>
> - No `requirements.lock.txt` exists, and `requirements.txt` says a lock file
>   is produced "once a unit is verified on real hardware".
> - The IR receiver's voltage question below is still open, which means nobody
>   has wired one.
> - `noise_db` is uncalibrated, which needs a sound level meter next to a
>   running mic.
> - The only compiled bytecode ever produced here is CPython 3.14, which is the
>   development machine's Python, not a Pi OS one.
> - The backend pipeline WAS proven end to end on 2026-05-02, but with curl,
>   not with this program. Those are different claims and only one of them has
>   been checked.
>
> So `init_ir`, `init_thermal`, `init_noise`, `thermal_loop`, `noise_loop` and
> `display_loop` are unexecuted code. Everything else here is covered by tests
> and has been reasoned about hard, but the first time this meets a bus, a
> level and a framebuffer, expect it to be wrong somewhere. Budget a bench day
> before a venue day.
>
> **The thermal path is newer than the rest of that.** On 2026-08-26 the sensor
> was changed from an MLX90640 to the FLIR Lepton the build plan always
> specified, so `ThermalCamera`, every V4L2 ioctl in it, and the counting
> thresholds around it were written from datasheets and have never been issued
> to a board. The two things most likely to be wrong on the bench, both called
> out where they live in the code:
>
> - **The camera may not be radiometric.** Some PureThermal firmware exposes
>   two video nodes, one raw Y16 and one 8-bit AGC greyscale. The AGC one
>   opens, streams, and gives numbers that are not temperatures.
>   `--selftest` now says which one you have instead of counting nonsense out
>   of it.
> - **`THERMAL_MIN_CLUSTER` is derived from lens geometry, not measured.** See
>   Calibration. Until someone stands in front of a unit, the headcount is a
>   relative signal.
>
> One class of mistake there is at least pinned rather than hoped at. V4L2
> encodes the size of each argument struct into the ioctl request number, so a
> struct one byte off does not give a subtly wrong frame, it gives `ENOTTY` and
> a camera that never opens. `test_main.py` asserts the request numbers and
> both struct sizes against the kernel's documented values, on the developer
> machine, before anyone plugs anything in. That bug was in the first draft of
> this code and the test is what found it.

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

  **Be careful how you say this one.** The old MLX90640 was 768 pixels, and
  this section used to argue that a face was "a few warm blobs" at that
  resolution. That argument does not survive the move to a 160x120 Lepton: a
  person in one of these frames is a clear human silhouette. What is still
  exactly true, and is the thing worth saying, is that no frame leaves the
  function that counts it. There is no image library on the device to encode
  one with, no file it is written to, and nothing in the payload but three
  integers. `frontend/src/__tests__/legalPagesMatchCode.test.js` and
  `test_main.py` both pin that: no capture library, no encoder, no frame
  reaching a file. If someone adds a heatmap view (see Known gaps), the
  argument changes and this paragraph has to change with it.
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

The one thing to be careful about: it is written as a promise about a device
that has never been switched on. Before the first venue install, re-read
section 3 against the running unit rather than against this file.

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

Four ways out, in the order they cost least. **This is Jayden's call, not the
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
| **A reading the backend will never accept (400)** | Dropped, with the reason logged. One bad reading is worth losing; re-sending it every 30 seconds forever is not. |
| **A sensor fails at startup** | That signal reports 0 and the other two carry on. Repeated read errors are logged once every 5 minutes, not every 2 seconds. |
| **A sensor stops answering mid-shift** | Same: it reports 0, not the last number it read. The thermal count and the noise level are latched values, so without this a bus that locked up at 11pm went on posting 11pm's headcount every 30 seconds, and the venue card showed a packed room at 4am. Thermal goes to 0 after 90 seconds without a good read, the mic after 60. |
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

**`THERMAL_MIN_CLUSTER` is derived, not measured, and this is the number to
check first on a bench.** The arithmetic behind the default of 12, so it can be
argued with:

- The standard Lepton 3.5 lens is about 57° horizontal, so at distance `d` the
  frame is roughly `1.09 × d` metres wide, and 160 pixels across it is about
  `147 / d` pixels per metre.
- At 3 m that is 49 px/m, so an adult head is very roughly 8 by 11 pixels, call
  it 80 to 120 raw pixels of bare skin. At 5 m it is 30 px/m and the same head
  is 30 to 45.
- Pixels are mean-pooled into `THERMAL_BIN × THERMAL_BIN` cells before counting
  (default 2), so divide by four: about 20 to 30 cells at 3 m, about 8 at 5 m.
- The default of 12 cells (48 raw pixels) sits between those. **That is a
  deliberate bias toward missing a distant person rather than counting sensor
  noise as a crowd**, because an invented person is a worse number to publish
  than a missing one.

None of that is a measurement. Nobody has stood in front of one of these. On
the bench: run `main.py --selftest`, which prints the cluster count it sees
right now, and walk in and out of frame. If one person reads as two, the
silhouette is fragmenting and `THERMAL_BIN` should go up before
`THERMAL_MIN_CLUSTER` does. If an empty room reads as one or more people, raise
`THERMAL_MARGIN_C` first, then `THERMAL_MIN_CLUSTER`.

**Fragmentation is the failure mode the old sensor did not have.** On a 24x32
grid a whole person was a handful of pixels and blurred into one blob. At
160x120 a bare head and a clothed torso can be two separate warm regions with a
cool band between them, and a naive count reports two people. The code answers
that with mean-pooling and eight-connectivity (a diagonal touch joins two
regions), which is enough in the frames the tests construct and has never been
checked against a real body.

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

## Known gaps

Things that are still open, so nobody has to rediscover them.

1. **This has never run on a Pi.** See the status box at the top. It is the
   gap every other gap here is downstream of.
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
8. **The demo unit's thermal heatmap view does not exist.** Step 6 of the locked
   pitch choreography is "tap the touchscreen, see the heat signature of the
   hand". `display_loop` handles no touch events and has no heatmap view, and
   the frame it would draw is discarded inside `count_thermal_clusters` by
   design. The Lepton is what makes that view worth building, and it is also
   what makes it a bigger decision than it was: holding a 160x120 frame in
   memory to draw it means holding a recognisable human silhouette, where the
   old sensor's frame was warm smudges. It is a privacy-relevant change and
   belongs in the policy discussion in "What it collects" before it belongs in
   code, and the two tests named there will fail on the commit that tries it,
   which is correct.
9. **The pin conflict is unresolved.** Moving thermal to USB freed I2C but a
   40-pin cellular HAT still covers the pins the break-beam and the mic's ADC
   need. See "The pin conflict, which is still open". Jayden's decision, and it
   blocks ordering the modem, not the sensors.
10. **The Lepton path has never been executed.** Every V4L2 ioctl in
   `ThermalCamera` was written from documentation. The frame reader, the
   radiometric check, the shutter check and the cluster thresholds are all
   first contact on the bench day.
