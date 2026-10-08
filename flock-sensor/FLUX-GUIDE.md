# Flux: what it is, and every part in it

Flux is the venue sensor behind Flock's Live Occupancy card. It watches one
room and reports two numbers: **how many people are in it** and **how loud it
is**. It keeps no pictures and no sound. The thermal camera sees heat, not
faces; the door counter sees distances, not people; the sound meter turns sound
into a decibel figure on its own chip. Only counts and levels ever leave the
box.

This page names every part, says what it does, where it sits, and what it
plugs into. The case is drawn in `enclosure/`, and `enclosure/README.md` is
its build sheet, with a picture for every assembly step.

## The box

One unit, 180 x 171.5 x 72 mm, the width of its seven inch screen: a navy
body with cream accents.

- **The front** is the screen, behind a thin navy lip that shows only its
  picture and its own slim black border. Under it a cream pill holds the
  thermal camera's eye, the door counter's window and the one light, and
  under that the Flux wordmark in cream.
- **Inside**, behind the screen, the battery stands at the left and the Pi with
  its 4G board sits at the right. The sound meter listens through a small hole
  in the right side.
- **The back** carries the Pi and a port panel: ETHERNET, USB and CHARGE.

On a table it leans back on a cream stand, like a desk display. On the wall
above a door, the CAMVATE ball head holds it by the mount on its back, tilted
down so the camera and the counter look at the doorway and the screen faces
the people coming in.

## What it does, step by step

1. **The thermal camera** sends a 160 x 120 heat picture to the Pi nine times a
   second over USB.
2. **Owl**, the people-counting model in `models/people.onnx`, finds the people
   in that picture and counts them. The picture is then thrown away.
3. **The door counter** measures an 8 x 8 grid of distances fifteen times a
   second and counts people walking in and out of the doorway, and which way.
4. **The sound meter** measures the room's loudness in decibels, and the Pi
   reads that one number twice a second.
5. **The Pi** (`main.py`) puts them together, shows them on the screen, and
   every 30 seconds sends the counts and the loudness to Flock over Wi-Fi or 4G.

## Every part, named

| Part | What it does in Flux | Where it sits | Plugs into |
|---|---|---|---|
| **Raspberry Pi 5 (8 GB)** | The computer: reads the sensors, runs Owl, draws the screen, sends the readings | On the back sheet, right | Power from the converter; everything else plugs into it |
| **Raspberry Pi Active Cooler** | Keeps the Pi cool while Owl runs nonstop | On the Pi, under the 4G board | The Pi's FAN socket |
| **microSD card** | Holds Raspberry Pi OS and the Flux software | The Pi's card slot | |
| **Waveshare SIM7600G-H 4G HAT** | Gets Flux online where there is no Wi-Fi | On the Pi's 40 pins, 18 mm up on standoffs over the cooler | Its USB port to a Pi USB port |
| **4G antenna** (flexible, stick-on) | The modem's signal | Stuck inside the right wall, low: plastic and acrylic let radio through. The kit's 14.5 cm blade antenna would stick out of a box this size, so it stays in its bag | The HAT's MAIN connector |
| **SIM card** (standard size) | The data plan | The HAT's SIM holder, underneath it: put it in before stacking | |
| **7 inch 1024 x 600 HDMI touchscreen** | Shows the live count, the loudness and the heat view; tap a card to open it | The front | Video ribbon to the Pi; touch USB to the Pi |
| **Anker Prime 20K 200W power bank (A1336)** | Runs Flux with no wall plug | Standing on its end, left | USB-C to the power converter; charges through the back |
| **Power converter (USB-C PD to 5 V 5 A)** | Gives the Pi the 5 A it wants from a battery whose own 5 V stops at 3 A | Over the Pi | Battery in, Pi's USB-C out |
| **FLIR Lepton 3.5 on a GroupGets PureThermal 3** | The thermal camera: Owl counts people in what it sees | Behind the eye in the strip | USB-C to the Pi |
| **VL53L8CX door counter (Pololu #3419)** | Counts people in and out of the doorway | Behind the window right of the eye | I2C, through the Qwiic MultiPort; its SPI/I2C pin capped to GND |
| **PCB Artists I2C Decibel Meter PRO** | Measures loudness in real decibels; no audio ever reaches the Pi | In its frame on the right wall, hearing through the hole | I2C, through the Qwiic MultiPort (5-pin lead, INT left empty) |
| **Qwiic SHIM and MultiPort** | Split the Pi's one I2C bus between the counter and the meter, all plug-in | On the 4G board's pins, and loose beside them | Pi pins 1, 3, 5, 6 |
| **LINK light** (green 3 mm LED, 330 ohm resistor) | Blinks while the sensors are answering and readings are going out | The strip, far right | GPIO 24 (pin 18), ground (pin 20) |
| **CHARGE port** (Adafruit #6069) | Charges the battery without opening the box | Back, port panel | The battery's other USB-C |
| **USB port** (Adafruit #4055) | Plug in a keyboard or a USB stick without opening the box | Back, port panel | The Pi's fourth USB port |
| **ETHERNET port** (panel-mount RJ45) | A wired network, where a venue has one | Back, port panel | The Pi's Ethernet, through a right-angle adapter |

The counter and the meter share the same wires. That works because I2C is a
shared bus where each part answers to its own address: 0x29 for the counter,
0x48 for the meter. `i2cdetect -y 1` on the Pi shows both.

## The cables

| Cable | From | To |
|---|---|---|
| **Camera** | PureThermal 3 (right-angle USB-C) | Pi USB |
| **Touch** | Screen's "5V+Touch" micro-USB (right-angle) | Pi USB |
| **Video** | Screen's flat HDMI ribbon socket | Pi micro HDMI 0, through a ribbon adapter |
| **Modem** | 4G board's "USB" micro-USB (right-angle) | Pi USB |
| **Power** | Battery | Converter, then the Pi's USB-C |
| **Charging** | Back's CHARGE port | Battery |
| **USB** | Back's USB port | Pi USB |
| **Ethernet** | Back's ETHERNET port | Pi Ethernet |
| **I2C** | Qwiic SHIM on pins 1, 3, 5, 6 | MultiPort, then the counter and the meter |

## The Pi's pins this build uses

All reached through the 4G board, whose pins carry the Pi's straight through.

| Pin | Name | Goes to |
|---|---|---|
| 1 | 3V3 | The Qwiic SHIM: the counter's VIN and the meter's 3V3 |
| 3 | SDA (GPIO 2) | The Qwiic SHIM |
| 5 | SCL (GPIO 3) | The Qwiic SHIM |
| 6 | GND | The Qwiic SHIM |
| 18 | GPIO 24 | The LINK light, through its resistor |
| 20 | GND | The LINK light |

The 4G board itself uses pins 8 and 10 (its serial line) and pin 31 (its power
key). Never put the counter or the meter on a 5 V pin; both are 3.3 V parts.

## The settings that go with this box

In `/etc/flock-sensor/flock_sensor.env`:

```
LED_LINK_GPIO=24
DOOR_SENSOR=tof
NOISE_SENSOR=auto
```

and `THERMAL_UPSIDE_DOWN=1` if the heat view on the screen comes out upside
down, which depends on which way up the camera's board ended up.

## The case parts

**Printed:** the body (the whole box but its back, with every post, pocket
and frame built in), four Pi spacers, the cream stand, and two fit tests to
print first.
**Also printed:** the sensor pill in cream, and the wordmark in cream on a two-colour
printer (or a cream paint pen in its pocket).
**Laser cut from 3 mm dark blue acrylic:** the back sheet.

## The small parts, and what each is for

| Part | For |
|---|---|
| Brass M3 heat-set inserts | Melted into the sleeve with the soldering iron, eight of them, so the screws grip metal: four for the screen, four for the back |
| Nylon standoff kit | Spares for the Pi stack |
| 3 mm LEDs | The LINK light |
| CAMVATE C1991 ball head (pair, 24007) | Screws to the wall over the door and holds Flux by the arm mount on its back, tilted down at the doorway |
| Arm mount block | A printed plug through the back sheet with a 1/4"-20 nut in it; the ball head screws in here |
| 1/4"-20 hex nuts (2) | One in the arm mount block, one in the base for the stand; each 1 mm under its face so the ball head's short screw takes four threads |
| VHB tape | Holds the sensor pill in its pocket, so no screw shows on the front |
| Double-sided foam tape | Seals the sound meter to its hole, so it hears the room and not the inside of the box |
| Rubber feet | Under the base |
