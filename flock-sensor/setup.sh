#!/bin/bash
# Flock venue sensor — one-shot installer for Raspberry Pi (Raspberry Pi OS).
# Run from the directory containing this script: sudo ./setup.sh
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Run as root (sudo ./setup.sh)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> apt update + install deps"
apt-get update
apt-get install -y python3-pip python3-dev i2c-tools

echo "==> pip install python deps"
pip3 install --break-system-packages -r "${SCRIPT_DIR}/requirements.txt"

echo "==> enable I2C + SPI"
raspi-config nonint do_i2c 0
raspi-config nonint do_spi 0

echo "==> install systemd unit"
cp "${SCRIPT_DIR}/flock-sensor.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable flock-sensor

if [ ! -f /home/pi/flock_sensor.env ]; then
  echo "==> seeding /home/pi/flock_sensor.env from example (EDIT IT WITH YOUR API KEY)"
  cp "${SCRIPT_DIR}/flock_sensor.env.example" /home/pi/flock_sensor.env
  chown pi:pi /home/pi/flock_sensor.env
fi

if [ ! -d /home/pi/flock-sensor ]; then
  echo "==> linking sensor source into /home/pi/flock-sensor"
  ln -s "${SCRIPT_DIR}" /home/pi/flock-sensor
fi

systemctl restart flock-sensor

echo ""
echo "Setup complete. Sensor service is running."
echo "Edit /home/pi/flock_sensor.env to set your API key, then:"
echo "  sudo systemctl restart flock-sensor"
echo "  journalctl -u flock-sensor -f   (to follow logs)"
