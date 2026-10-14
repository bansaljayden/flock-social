#!/bin/bash
# Flock venue sensor: put the Waveshare SIM7600G-H 4G board online with a
# Hologram SIM.
#
#   sudo ./cellular.sh            set it up (safe to re-run)
#   sudo ./cellular.sh --status   only report what the modem is doing
#
# Wi-Fi and Ethernet stay first choice: the cellular connection gets a higher
# route metric, so the Pi sends over it only when nothing else is up.
# Hologram bills by the megabyte, which is why it is the fallback and not the
# default. README.md, Cellular, has the steps around this script.
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run as root (sudo ./cellular.sh)" >&2
  exit 1
fi

CON_NAME=hologram
APN=hologram
# SIMCom's USB id for the SIM7600 family in its default mode.
MODEM_USB_ID=1e0e:9001
# The board's power key is on pin 31, GPIO 6, when it sits on the 40 pins.
PWRKEY_GPIO=6

modem_on_usb() { lsusb | grep -qi "${MODEM_USB_ID}"; }

first_modem() { mmcli -L 2>/dev/null | grep -o '/Modem/[0-9]*' | head -1 | grep -o '[0-9]*$' || true; }

status() {
  echo "==> USB"
  if modem_on_usb; then
    echo "    4G board found (${MODEM_USB_ID})"
  else
    echo "    4G board NOT on USB"
  fi
  local m
  m="$(first_modem)"
  if [ -z "$m" ]; then
    echo "==> ModemManager sees no modem yet"
    return 0
  fi
  echo "==> modem ${m}"
  mmcli -m "$m" | grep -E 'state|power state|signal quality|access tech|operator name|registration' | sed 's/^ */    /' || true
  echo "==> SIM"
  mmcli -m "$m" | grep -E 'primary sim|sim slot' | sed 's/^ */    /' || true
  echo "==> connections"
  nmcli -t -f NAME,TYPE,DEVICE,STATE connection show --active | sed 's/^/    /'
  local dev
  dev="$(nmcli -t -f GENERAL.DEVICES connection show "${CON_NAME}" 2>/dev/null | cut -d: -f2 || true)"
  if [ -n "$dev" ]; then
    echo "==> data over ${dev} since it came up"
    ip -s link show "$dev" | awk '/RX:/{getline; print "    received " $1 " bytes"} /TX:/{getline; print "    sent     " $1 " bytes"}'
  fi
}

if [ "${1:-}" = "--status" ]; then
  status
  exit 0
fi

echo "==> install ModemManager"
apt-get install -y modemmanager >/dev/null
systemctl enable --now ModemManager >/dev/null

if ! modem_on_usb; then
  # A board on the 40 pins can be switched on from here. A board sitting
  # beside the Pi on its USB cable alone has nothing on GPIO 6, so this does
  # nothing to it; its own PWRKEY button does the same job.
  echo "==> 4G board not on USB yet: pressing its power key (GPIO ${PWRKEY_GPIO})"
  if command -v pinctrl >/dev/null; then
    pinctrl set "${PWRKEY_GPIO}" op dh
    sleep 2
    pinctrl set "${PWRKEY_GPIO}" op dl
    pinctrl set "${PWRKEY_GPIO}" ip
  fi
  for _ in $(seq 1 30); do
    modem_on_usb && break
    sleep 1
  done
fi
if ! modem_on_usb; then
  echo "The 4G board is not showing up on USB." >&2
  echo "  - Is its USB cable from the board's 'USB' port to a Pi USB port?" >&2
  echo "  - Is its PWR light on? If only that is on, press its PWRKEY button for a second." >&2
  echo "  Then run this again." >&2
  exit 1
fi

echo "==> waiting for ModemManager to pick it up"
for _ in $(seq 1 60); do
  [ -n "$(first_modem)" ] && break
  sleep 1
done
M="$(first_modem)"
if [ -z "$M" ]; then
  echo "ModemManager has not found the modem after a minute: sudo journalctl -u ModemManager -n 50" >&2
  exit 1
fi
if mmcli -m "$M" | grep -q 'sim-missing\|primary sim path: none'; then
  echo "No SIM card. Power off, put the Hologram SIM in the holder under the 4G board, try again." >&2
  exit 1
fi

echo "==> connection '${CON_NAME}' (APN ${APN})"
if nmcli -t -f NAME connection show | grep -qx "${CON_NAME}"; then
  nmcli connection modify "${CON_NAME}" gsm.apn "${APN}"
else
  nmcli connection add type gsm ifname '*' con-name "${CON_NAME}" apn "${APN}"
fi
# Higher metric than Wi-Fi (600) and Ethernet (100): cellular is the fallback.
nmcli connection modify "${CON_NAME}" connection.autoconnect yes \
  ipv4.route-metric 700 ipv6.route-metric 700

echo "==> bringing it up (a new SIM can take a few minutes to register)"
if ! nmcli --wait 120 connection up "${CON_NAME}"; then
  echo "" >&2
  echo "It did not connect. The usual reasons, most likely first:" >&2
  echo "  - The SIM is not activated yet on dashboard.hologram.io." >&2
  echo "  - No signal: is the antenna on the board's MAIN socket?" >&2
  echo "Run 'sudo ./cellular.sh --status' to see the signal and the SIM's state." >&2
  exit 1
fi

DEV="$(nmcli -t -f GENERAL.DEVICES connection show "${CON_NAME}" | cut -d: -f2)"
echo "==> test: reach the internet over ${DEV} alone"
if curl -sS --interface "${DEV}" --max-time 20 -o /dev/null -w '    HTTP %{http_code} in %{time_total}s\n' https://www.google.com/generate_204; then
  echo ""
  echo "Cellular works. It takes over by itself whenever Wi-Fi and Ethernet are gone."
else
  echo "Connected, but nothing came back over ${DEV}. Check the Hologram dashboard for data usage and the SIM's state." >&2
  exit 1
fi
echo ""
status
