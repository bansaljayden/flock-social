# Flux: what it is, and every part in it

Flux is the venue sensor behind Flock's Live Occupancy card. It watches one
room and reports two numbers: **how many people are in it** and **how loud it
is**. It keeps no pictures and no sound. The thermal camera sees heat, not
faces; the door counter sees distances, not people; the sound meter turns sound
into a decibel figure on its own chip. Only counts and levels ever leave the
box.

This page names every part, says what it does, where it lives, and what it
plugs into. The case drawings are in `enclosure/`, and `enclosure/README.md` is
the build sheet for them.

## The two units

Flux is two boxes joined by two cables.

| Unit | Where it goes | What is in it | Its job |
|---|---|---|---|
| **The base** | On a table, shelf or the host stand | Screen, Raspberry Pi, 4G board, battery, two lights | Thinks, shows the live numbers, sends them to Flock |
| **The head** | On the wall near the door, on a ball mount, tilted down | Thermal camera, door counter, sound meter, one light | Looks at and listens to the room |

They are separate because each has to be somewhere different. The head has to
see the room and the doorway from above; the base has to be where a person can
see its screen and charge its battery.

## What it does, step by step

1. **The thermal camera** sends a 160 x 120 heat picture to the Pi nine times a
   second over USB.
2. **Owl**, the people-counting model in `models/people.onnx`, finds the people
   in that picture and counts them. The picture is then thrown away.
3. **The door counter** measures an 8 x 8 grid of distances fifteen times a
   second and counts people walking in and out of the doorway.
4. **The sound meter** measures the room's loudness in decibels and the Pi reads
   that number twice a second.
5. **The Pi** (`main.py`) combines them, shows them on the screen, and every
   30 seconds sends the counts and the loudness to Flock over Wi-Fi or 4G.

## Every part, named

### In the base

| Part | What it is | What it does in Flux | Plugs into |
|---|---|---|---|
| **Raspberry Pi 5 (8 GB)** | The computer | Runs everything: reads the sensors, runs Owl, draws the screen, sends the readings | Power from the battery; everything else plugs into it |
| **Raspberry Pi Active Cooler** | A heatsink and small fan | Keeps the Pi cool while Owl runs nonstop | Clips onto the Pi, fan cable into the Pi's FAN socket |
| **microSD card** | The Pi's storage | Holds Raspberry Pi OS and the Flux software | The Pi's card slot |
| **Waveshare SIM7600G-H 4G HAT** | A cellular modem board | Gets Flux online where there is no Wi-Fi | Sits on the Pi's 40 pins on standoffs; its USB port goes to a Pi USB port |
| **4G antenna** | Antenna for the modem | Without it the modem gets no signal | The HAT's MAIN connector |
| **Nano SIM card** | The phone plan | Pays for the 4G data | The HAT's SIM slot |
| **7 inch 1024 x 600 HDMI touchscreen** | The display | Shows the live count, the loudness and the heat view | HDMI to the Pi; USB for touch and power |
| **Anker Prime 20K 200W power bank (A1336)** | The battery | Runs Flux with no wall plug | USB-C to the Pi's USB-C power port |
| **POWER light** (green 3 mm LED + 330 ohm resistor) | Front, under the screen, right side | On while Flux is running | GPIO 23 (pin 16), ground |
| **LINK light** (yellow 3 mm LED + 330 ohm resistor) | Beside POWER | Blinks while the head is answering and readings are going out | GPIO 24 (pin 18), ground |
| **Half-size breadboard with the GPIO ribbon (T-cobbler)** | The wiring hub | Joins the Pi's pins to the head cable and the lights, with no soldering | Ribbon to the HAT's pins |

### In the head

| Part | What it is | What it does in Flux | Plugs into |
|---|---|---|---|
| **FLIR Lepton 3.5 on a GroupGets PureThermal 3** | The thermal camera | Sees body heat across the room; Owl counts people in it | USB-C, through the 12 cm flat cable and the long USB cable, to the Pi |
| **VL53L8CX door counter (Pololu #3419)** | A distance sensor with an 8 x 8 grid | Counts people in and out through the door, and which way | The head's junction: 3V3, GND, SDA, SCL; its SPI/I2C pin to GND |
| **PCB Artists I2C Decibel Meter PRO** | A sound level meter on a chip | Measures loudness in real decibels; no audio ever reaches the Pi | Its JST-XH cable to the head's junction: 3V3, GND, SDA, SCL |
| **Mini breadboard (the head junction)** | The wiring hub in the head | Joins the cable's four wires to both sensors | Stuck inside the head's right wall |
| **HEAD light** (green 3 mm LED + 330 ohm resistor) | On the head's angled face | Steady while the head's sensors answer: the cable is good | GPIO 25 (pin 22), ground, through the head cable |

The door counter and the sound meter share the same four wires. That works
because I2C is a shared bus: each part answers to its own address, 0x29 for the
counter and 0x48 for the meter. `i2cdetect -y 1` on the Pi shows both.

### The cables

| Name | Cable | From | To |
|---|---|---|---|
| **C1 Pi power** | USB-C to USB-C, 30 cm | Battery | Pi USB-C |
| **C2 Screen picture** | Micro-HDMI to HDMI, 30 cm | Pi HDMI 0 (the one by the power port) | Screen HDMI |
| **C3 Screen touch** | USB-A to micro-USB, 30 cm | Pi USB | Screen touch port |
| **C4 Modem** | USB-A to micro-USB, 15 to 20 cm | Pi USB | HAT port labelled USB |
| **C5 Camera lead** | CableCreation CC0992, 12 cm flat USB-A to USB-C | Thermal camera, in the head | C6 |
| **C6 Camera run** | USB 3.0 extension, USB-A male to USB-A female, 3 m | C5, in the head | Pi USB (blue) |
| **C7 Head cable** | Cat6, 3 m, solid core | Base breadboard | Head junction |
| **C8 Meter lead** | JST-XH 4-pin to female jumper | Sound meter | Head junction (onto 4 header pins) |
| **C9 Counter leads** | 5 female-to-male jumpers | Door counter's pins | Head junction |
| **C10 Charging** | USB-C, from a wall charger | Wall | Battery, in through the back slot |
| **C11 Ribbon** | 40-pin GPIO ribbon (came with the T-cobbler) | HAT's pass-through pins | Base breadboard |

**C7, the head cable, wire by wire.** Cat6 has four twisted pairs. Each signal
rides with a ground, which is what lets I2C go three metres.

| Pair | Wire | Signal | Pi pin |
|---|---|---|---|
| Orange | orange | SDA | 3 |
| Orange | white-orange | GND | 6 |
| Green | green | SCL | 5 |
| Green | white-green | GND | 9 |
| Blue | blue | 3V3 | 1 |
| Blue | white-blue | GND | 14 |
| Brown | brown | HEAD light | 22 (GPIO 25) |
| Brown | white-brown | GND | 20 |

### The Pi's pins this build uses

| Pin | Name | Goes to |
|---|---|---|
| 1 | 3V3 | Head cable (blue): the counter's VIN and the meter's VCC |
| 3 | SDA (GPIO 2) | Head cable (orange) |
| 5 | SCL (GPIO 3) | Head cable (green) |
| 6, 9, 14, 20 | GND | Head cable grounds, the lights |
| 16 | GPIO 23 | POWER light |
| 18 | GPIO 24 | LINK light |
| 22 | GPIO 25 | HEAD light, through the head cable |

Never put the counter or the meter on a 5V pin. Both are 3.3 V parts.

## The case parts

Every part below is a file in `enclosure/` and a named piece in the drawings.
`enclosure/README.md` says how to make and assemble each one.

**Base, laser cut from 3 mm acrylic:** front panel (window, screen screws,
lights, engraved Flux wordmark), back panel (Pi screws, cable slot, exhaust
vents), top, bottom (intake vents, tray screws), two sides.

**Base, 3D printed:** eight corner blocks, four screen spacers, four Pi spacers,
the battery tray, the cable grommet, and the screen fit test.

**Head, 3D printed:** the shell, the back plate (ball-mount nut and cable
notch), the lens ring, and the head fit test.

## The small parts, and what each is for

| Part | For |
|---|---|
| Brass M3 heat-set inserts | Melted into the printed parts with the soldering iron so screws grip metal: 3 in each corner block, 4 in the head |
| Nylon standoff kit (M2, M2.5, M3) | Holding boards off the walls: Pi (M2.5), 4G HAT on the Pi (M2.5), door counter (M2), screen (M3) |
| 3 mm LEDs | The POWER, LINK and HEAD lights |
| 330 ohm resistors | One per light, or the LED burns out |
| Camvate ball mount | Holds the head on the wall and lets it tilt toward the door |
| 1/4"-20 hex nut | Trapped in the head's back plate; the ball mount screws into it |
| Double-sided foam tape | Seals the sound meter's microphone to its hole in the head, so it hears the room and not the inside of the box |
| 25 mm hook-and-loop strap | Holds the battery in its tray |
| Rubber feet | Under the base, so air reaches the vents underneath |
