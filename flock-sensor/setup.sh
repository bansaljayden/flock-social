#!/bin/bash
# Flock venue sensor: one-shot installer for Raspberry Pi OS.
#
#   sudo ./setup.sh
#
# Safe to re-run: it never overwrites an existing config file, and it upgrades
# an installation in place.
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run as root (sudo ./setup.sh)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR=/opt/flock-sensor
CONFIG_DIR=/etc/flock-sensor
CONFIG_FILE="${CONFIG_DIR}/flock_sensor.env"

# ---------------------------------------------------------------------------
# Which account runs the service?
#
# Raspberry Pi OS stopped shipping a default `pi` user in 2022, and the first-boot
# wizard lets the installer choose any name. Hardcoding `pi` meant setup
# appeared to succeed and the service then failed to start on every current
# image.
# ---------------------------------------------------------------------------
SERVICE_USER="${FLOCK_SERVICE_USER:-${SUDO_USER:-}}"
if [ -z "${SERVICE_USER}" ] || [ "${SERVICE_USER}" = "root" ]; then
  SERVICE_USER="$(getent passwd 1000 | cut -d: -f1 || true)"
fi
if [ -z "${SERVICE_USER}" ] || ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "Could not work out which user should run the sensor." >&2
  echo "Re-run as: sudo FLOCK_SERVICE_USER=<username> ./setup.sh" >&2
  exit 1
fi
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
echo "==> service will run as ${SERVICE_USER}:${SERVICE_GROUP}"

echo "==> apt update + install deps"
apt-get update
# v4l-utils is not a runtime dependency, it is the only way to diagnose a
# thermal camera that comes up on the wrong node or in the wrong mode, on a
# box nobody is standing next to. `v4l2-ctl --list-devices` is in the README.
apt-get install -y python3-pip python3-dev v4l-utils
# The trained people counter. From apt, not pip: Debian builds onnxruntime for
# the Pi's arm64, and a pip wheel is one more thing to go stale. A unit without
# them counts with the heat-cluster rule and says so in the log.
apt-get install -y python3-numpy python3-onnxruntime \
  || echo "    WARNING: numpy/onnxruntime did not install; counting with the heat-cluster rule." >&2

echo "==> pip install python deps"
# --break-system-packages: this is a single-purpose appliance, and the Adafruit
# Blinka / RPi.GPIO stack is fiddly inside a venv. Do not reuse this Pi for
# anything else.
#
# The flag only exists in pip 23.0.1 and later. Raspberry Pi OS Bullseye ships
# an older pip that does not need it and rejects it outright, and with `set -e`
# that aborted the whole install after apt had already run. Try it, fall back.
pip_install() {
  pip3 install --break-system-packages "$@" 2>/dev/null || pip3 install "$@"
}
pip_install -r "${SCRIPT_DIR}/requirements.txt"

# ---------------------------------------------------------------------------
# GPIO library, which depends on the board.
#
# The Pi 5 moved GPIO behind the RP1 southbridge. RPi.GPIO cannot drive it, so
# on a Pi 5 the doorway counter fails at startup and the unit reports 0
# crossings for as long as it is deployed. `rpi-lgpio` provides the same module
# and API on top of lgpio, so main.py needs no change. They cannot coexist.
# ---------------------------------------------------------------------------
BOARD="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"
echo "==> board: ${BOARD:-unknown}"
case "${BOARD}" in
  "Raspberry Pi 5"*)
    echo "    Pi 5: swapping RPi.GPIO for rpi-lgpio"
    # The uninstall needs the same flag as every install here. Without it,
    # current Raspberry Pi OS (Debian trixie) refuses it as an externally
    # managed environment, the refusal went to /dev/null, and the old
    # library stayed in /usr/local, which Python searches before the
    # system's rpi-lgpio. Every Pi 5 set up this way imported the library
    # that cannot drive its GPIO, and nothing said so.
    pip3 uninstall -y --break-system-packages RPi.GPIO >/dev/null 2>&1 \
      || pip3 uninstall -y RPi.GPIO >/dev/null 2>&1 || true
    pip_install rpi-lgpio
    # Check what Python actually imports, rather than what was asked for.
    if ! python3 -c "import inspect, RPi.GPIO as G; raise SystemExit('lgpio' not in inspect.getsource(G))" 2>/dev/null; then
      echo "    WARNING: python3 still imports the old RPi.GPIO, which cannot drive a Pi 5." >&2
      echo "    Remove it by hand: sudo pip3 uninstall --break-system-packages RPi.GPIO" >&2
    fi
    ;;
esac

# SPI for the microphone's converter, I2C for the doorway counter. I2C was
# left off while the thermal camera's move to USB meant nothing used it; the
# VL53L8CX uses it now.
echo "==> enable SPI and I2C"
if command -v raspi-config >/dev/null 2>&1; then
  raspi-config nonint do_spi 0
  raspi-config nonint do_i2c 0
else
  echo "    raspi-config not found, so this does not look like Raspberry Pi OS." >&2
  echo "    Enable SPI and I2C by hand before the mic and the doorway counter will work." >&2
fi

# The bus stays at the Pi's default 100 kHz. The counter's 86 KB firmware
# then takes about eight seconds to load at each start, where 400 kHz would
# take two, but the head sits at the end of three metres of Cat6, and a bus
# too fast for its cable fails the firmware checksum instead of running
# slowly. README.md, The doorway counter, has the line for a short cable.

# The thermal camera needs no bus enabled, but it does need to have enumerated.
if [ ! -e /dev/video0 ]; then
  echo "    WARNING: /dev/video0 does not exist. If the Lepton is plugged in," >&2
  echo "    check the USB cable and run 'v4l2-ctl --list-devices'; set" >&2
  echo "    THERMAL_DEVICE in the config if it came up on another node." >&2
fi

echo "==> install source to ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
install -m 0755 -o root -g root "${SCRIPT_DIR}/main.py" "${INSTALL_DIR}/main.py"
# The panel's fonts and marks. Optional: a venue unit has no screen and draws
# nothing, and a demo unit without them still draws, in pygame's plain face.
if [ -d "${SCRIPT_DIR}/flux-assets" ]; then
  mkdir -p "${INSTALL_DIR}/flux-assets"
  install -m 0644 -o root -g root "${SCRIPT_DIR}"/flux-assets/* "${INSTALL_DIR}/flux-assets/"
fi
# The trained people counter. main.py uses it when it is here and numpy and
# onnxruntime are installed, and the heat-cluster rule otherwise.
if [ -d "${SCRIPT_DIR}/models" ]; then
  mkdir -p "${INSTALL_DIR}/models"
  install -m 0644 -o root -g root "${SCRIPT_DIR}"/models/* "${INSTALL_DIR}/models/"
fi
# The doorway counter's firmware, with ST's licence and notice beside it.
# main.py loads it into the sensor on every start; without it a unit with the
# counter fitted reports no crossings and says why in the log.
if [ -d "${SCRIPT_DIR}/vl53l8cx" ]; then
  mkdir -p "${INSTALL_DIR}/vl53l8cx"
  install -m 0644 -o root -g root "${SCRIPT_DIR}"/vl53l8cx/* "${INSTALL_DIR}/vl53l8cx/"
fi

# ---------------------------------------------------------------------------
# Config: 0600, owned by the service user. It contains the device API key, and
# a key readable by every account on the box is a key anyone with a keyboard
# can walk off with.
# ---------------------------------------------------------------------------
echo "==> config"
mkdir -p "${CONFIG_DIR}"
# The directory too, not only the file inside it. root creates it here, so
# it came out root:root 0750 and the service user had no traverse bit: the
# 0600 config it owns was still unopenable, and the device reports a missing
# API key on a box where the key is present and correct. Bench, 2026-09-06.
chown root:"${SERVICE_GROUP}" "${CONFIG_DIR}"
chmod 0750 "${CONFIG_DIR}"

LEGACY_CONFIG="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)/flock_sensor.env"
if [ ! -f "${CONFIG_FILE}" ] && [ -f "${LEGACY_CONFIG}" ]; then
  echo "    migrating ${LEGACY_CONFIG} -> ${CONFIG_FILE}"
  mv "${LEGACY_CONFIG}" "${CONFIG_FILE}"
elif [ ! -f "${CONFIG_FILE}" ]; then
  echo "    seeding from the example (EDIT IT, it has no API key yet)"
  cp "${SCRIPT_DIR}/flock_sensor.env.example" "${CONFIG_FILE}"
fi
chown "${SERVICE_USER}:${SERVICE_GROUP}" "${CONFIG_FILE}"
chmod 0600 "${CONFIG_FILE}"

echo "==> install systemd unit"
# systemd refuses to start a unit naming a group that does not exist, so keep
# only the ones this image actually has. Missing hardware groups are also the
# usual reason a sensor that works when run by hand fails under systemd, so add
# the service user to each surviving one.
#
# The list is the unit file's own. This loop used to carry a list of three
# (spi gpio video) and then rewrite the unit's line with the survivors, so
# every installed unit lost input and render, which the touchscreen needs,
# and would have lost i2c, which the doorway counter needs, while the unit
# file in the repo looked right.
WANTED_GROUPS="$(sed -n 's/^SupplementaryGroups=//p' "${SCRIPT_DIR}/flock-sensor.service")"
PRESENT_GROUPS=""
for grp in ${WANTED_GROUPS}; do
  if getent group "${grp}" >/dev/null 2>&1; then
    PRESENT_GROUPS="${PRESENT_GROUPS}${PRESENT_GROUPS:+ }${grp}"
    adduser "${SERVICE_USER}" "${grp}" >/dev/null 2>&1 || true
  else
    echo "    group '${grp}' not present on this image, skipping" >&2
  fi
done

sed -e "s/^User=.*/User=${SERVICE_USER}/" \
    -e "s/^Group=.*/Group=${SERVICE_GROUP}/" \
    -e "s/^SupplementaryGroups=.*/SupplementaryGroups=${PRESENT_GROUPS}/" \
    "${SCRIPT_DIR}/flock-sensor.service" > /etc/systemd/system/flock-sensor.service
if [ -z "${PRESENT_GROUPS}" ]; then
  sed -i '/^SupplementaryGroups=$/d' /etc/systemd/system/flock-sensor.service
fi
chmod 0644 /etc/systemd/system/flock-sensor.service

# Keep the clock honest: an unset clock breaks TLS and mis-stamps readings.
timedatectl set-ntp true >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable flock-sensor
systemctl restart flock-sensor

echo ""
if grep -q 'your_api_key_here' "${CONFIG_FILE}" 2>/dev/null || \
   ! grep -qE '^FLOCK_API_KEY=.+' "${CONFIG_FILE}" 2>/dev/null; then
  echo "SETUP INCOMPLETE. No API key yet."
  echo "  1. sudo nano ${CONFIG_FILE}      (set FLOCK_API_KEY and SENSOR_DEVICE_ID)"
  echo "  2. sudo systemctl restart flock-sensor"
  echo "  3. sudo -u ${SERVICE_USER} python3 ${INSTALL_DIR}/main.py --selftest"
else
  echo "Setup complete. Verifying..."
  sudo -u "${SERVICE_USER}" FLOCK_CONFIG="${CONFIG_FILE}" python3 "${INSTALL_DIR}/main.py" --selftest || true
fi
echo ""
echo "Logs: journalctl -u flock-sensor -f"
