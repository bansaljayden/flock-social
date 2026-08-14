# Flock venue sensor

A Raspberry Pi that sits at a venue entrance and reports **how busy the room
is** to the Flock backend, where it becomes the "Live Occupancy" card in the
app and a ground-truth signal for the crowd model.

This is the only part of Flock that runs on hardware, in a building we do not
control, on wifi we do not control, with nobody around to restart it. Every
design choice below follows from that.

---

## What it collects (and what it cannot)

Three numbers, every 30 seconds:

| Field | What it is | How it is measured |
|---|---|---|
| `ir_beam_count` | Doorway crossings since the last reading | An infrared beam across the doorway; each break counts once |
| `thermal_headcount` | Warm bodies in the camera's field of view | Heat clusters in a 24×32 thermal grid |
| `noise_db` | Ambient loudness | RMS level from a microphone |

**It counts. It cannot identify anyone.**

- The thermal grid is 768 pixels of temperature. It is reduced to a cluster
  count inside `count_thermal_clusters()` and discarded. It is never written to
  disk and never transmitted. At that resolution a face is a few warm blobs;
  there is no image to leak.
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

> **Open item.** The published privacy policy
> (`frontend/src/website/PrivacyPolicy.js`) does not mention venue sensors at
> all. Deploying a unit into a real venue before that page describes thermal
> headcount and ambient noise measurement is shipping undisclosed collection.
> See "Known gaps" at the bottom.

---

## Hardware

| Part | Connects to | Pi pins |
|---|---|---|
| IR break-beam receiver | GPIO 17 (falling edge, internal pull-up) | signal → pin 11 |
| MLX90640 thermal camera | I2C bus 1 | SDA pin 3, SCL pin 5, 3V3 pin 1, GND pin 6 |
| MCP3008 ADC | SPI bus 0, CE0 | CLK pin 23, DOUT pin 21, DIN pin 19, CS pin 24, VDD+VREF 3V3, AGND+DGND GND |
| MAX4466 microphone | MCP3008 channel 0 | OUT → MCP3008 pin 1, VCC 3V3, GND |
| 800×480 display (demo units only) | HDMI / DSI | — |

> ⚠️ **Confirm with a unit in hand before the first install:** many break-beam
> receivers are 5V parts. The Pi's GPIO is **not** 5V tolerant. Use a receiver
> with an open-collector output pulled up to 3V3, or put a level shifter in
> line. Wiring a 5V signal straight into GPIO 17 will damage the Pi.

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
at mode 0600, adds the service user to the `i2c`/`spi`/`gpio` groups, and turns
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
the I2C, SPI and GPIO devices.

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
| **A sensor fails** | That signal reports 0 and the other two carry on. Repeated read errors are logged once every 5 minutes, not every 2 seconds. |
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
"person" — the failure that used to make a packed bar in August report a
headcount of 1. If a venue reports too few people, raise `THERMAL_MARGIN_C`; if
an empty room reports people, raise it further or raise `THERMAL_MIN_CLUSTER`.

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
| Service works by hand, fails under systemd | Missing hardware group membership | `sudo adduser <user> i2c` (also `spi`, `gpio`) then reboot |
| Headcount stuck at 0 | I2C not enabled or wiring | `i2cdetect -y 1` should show `33` |
| Headcount stuck at 1 in a busy room | Ambient too warm | Raise `THERMAL_MARGIN_C` |
| Crossings stuck at 0 | Beam misaligned or receiver unpowered | Break the beam by hand and watch the log |

---

## Known gaps

Things that are still open, so nobody has to rediscover them.

1. **The privacy policy does not mention this device.** No page describes
   thermal headcount or ambient noise measurement in a venue. This must be
   written before a unit goes into a venue with real customers in it.
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
4. **`noise_db` is uncalibrated** (see Calibration) but is stored in a column
   called `noise_db` and shown to users as decibels.
5. **`ir_beam_count` is crossings, not entries**, but the backend's history
   endpoint sums it as "entries per hour" and `RETRAIN.md` lists it as high
   quality ground truth.
6. **Dependencies are unpinned** (see Pinning).
7. **No fleet visibility.** `sensor_devices.last_seen_at` is the only health
   signal, and nothing alerts on it. A venue whose sensor died on Friday just
   quietly stops having a Live Occupancy card.
