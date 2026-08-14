#!/bin/bash
# Flock venue sensor — one-shot installer for Raspberry Pi OS.
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
# Raspberry Pi OS stopped shipping a default `pi` user in 2022 — the first-boot
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
apt-get install -y python3-pip python3-dev i2c-tools

echo "==> pip install python deps"
# --break-system-packages: this is a single-purpose appliance, and the Adafruit
# Blinka / RPi.GPIO stack is fiddly inside a venv. Do not reuse this Pi for
# anything else.
pip3 install --break-system-packages -r "${SCRIPT_DIR}/requirements.txt"

echo "==> enable I2C + SPI"
if command -v raspi-config >/dev/null 2>&1; then
  raspi-config nonint do_i2c 0
  raspi-config nonint do_spi 0
else
  echo "    raspi-config not found — this does not look like Raspberry Pi OS." >&2
  echo "    Enable I2C and SPI by hand before the thermal camera or mic will work." >&2
fi

echo "==> install source to ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
install -m 0755 -o root -g root "${SCRIPT_DIR}/main.py" "${INSTALL_DIR}/main.py"

# ---------------------------------------------------------------------------
# Config: 0600, owned by the service user. It contains the device API key, and
# a key readable by every account on the box is a key anyone with a keyboard
# can walk off with.
# ---------------------------------------------------------------------------
echo "==> config"
mkdir -p "${CONFIG_DIR}"
chmod 0750 "${CONFIG_DIR}"

LEGACY_CONFIG="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)/flock_sensor.env"
if [ ! -f "${CONFIG_FILE}" ] && [ -f "${LEGACY_CONFIG}" ]; then
  echo "    migrating ${LEGACY_CONFIG} -> ${CONFIG_FILE}"
  mv "${LEGACY_CONFIG}" "${CONFIG_FILE}"
elif [ ! -f "${CONFIG_FILE}" ]; then
  echo "    seeding from the example (EDIT IT — it has no API key yet)"
  cp "${SCRIPT_DIR}/flock_sensor.env.example" "${CONFIG_FILE}"
fi
chown "${SERVICE_USER}:${SERVICE_GROUP}" "${CONFIG_FILE}"
chmod 0600 "${CONFIG_FILE}"

echo "==> install systemd unit"
# systemd refuses to start a unit naming a group that does not exist, so keep
# only the ones this image actually has. Missing hardware groups are also the
# usual reason a sensor that works when run by hand fails under systemd, so add
# the service user to each surviving one.
PRESENT_GROUPS=""
for grp in i2c spi gpio video; do
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
  echo "SETUP INCOMPLETE — no API key yet."
  echo "  1. sudo nano ${CONFIG_FILE}      (set FLOCK_API_KEY and SENSOR_DEVICE_ID)"
  echo "  2. sudo systemctl restart flock-sensor"
  echo "  3. sudo -u ${SERVICE_USER} python3 ${INSTALL_DIR}/main.py --selftest"
else
  echo "Setup complete. Verifying..."
  sudo -u "${SERVICE_USER}" FLOCK_CONFIG="${CONFIG_FILE}" python3 "${INSTALL_DIR}/main.py" --selftest || true
fi
echo ""
echo "Logs: journalctl -u flock-sensor -f"
