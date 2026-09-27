# Training the people counter

The sensor used to count people in a thermal frame with a hand-written rule:
average the frame into 4 x 4 pixel cells, mark the warm ones, and count the
warm regions big enough to be a head. The rule has no idea what a person looks
like. A hand close to the lens is a region, so it counts; spread fingers can be
two regions, so they count twice; two people packed together can be one.
Telling those apart is shape recognition, which a small trained model does and
a threshold cannot.

The model here marks where each person's head is, and the count is the number
of marks. Published work on thermal people counting found that approach the
most accurate for counting. The rule stays in `main.py` as the fallback
whenever the model, numpy or onnxruntime is missing (`THERMAL_MODEL=off` forces
it).

## What it learns from

Two sources, mixed in every batch.

**Generated frames** from `synth.py`: a room at some temperature with people
at every distance and pose, drawn the way this camera sees them (160 x 120
pixels across 57 degrees, radiometric Celsius, soft edges, lens blur, sensor
noise, the few degrees of error an uncalibrated Lepton has, real-looking
texture). Mixed in are the things that fool a threshold: a hand held up to the
lens, fingers spread, a hot mug, a laptop, a radiator, a lamp, a pet, a warm
seat, a reflection in glass. Every thing gets a kind and a box; only people are
counted.

**Real frames** from public thermal datasets whose licences allow commercial
use: PUT Thermo Presence (MIT; a ceiling camera, real temperatures, a point
per person) and OpenThermalPose2 (MIT; side view, 8-bit). They label people
only, so only the people map is graded on them. Their test splits are never
trained on; the model is chosen on their validation splits and graded on the
test splits, which is the only honest measure of how it does on footage it has
not seen. The frames stay on the development machine and never enter this
repository. Why both: owl-2, trained on generated frames alone, counted
perfectly on drawings and badly on real footage, reading the texture of a real
room as people.

Nothing a Flux sensor saw is ever used; a sensor keeps no frame. The model
names kinds of things and cannot tell one person from another.

## What is here

| File | Runs on | What it does |
|---|---|---|
| `synth.py` | the PC | Draws synthetic thermal frames with a label point per person |
| `model.py` | the PC | The network: 2 x 120 x 160 in, a 30 x 40 map of head points out |
| `train.py` | the PC | Trains it, compares it with the rule on held-out frames, exports `people.onnx` |
| `record.py` | the Pi | Records real frames into `~/flux-training/<room>/`, with consent |
| `frames.py` | both | The recording file format: one session per file, one frame per line |

## Training

```bash
python -m venv venv && venv/bin/pip install torch numpy scipy onnx requests
venv/bin/python train.py --out runs/1 --steps 30000
cp runs/1/people.onnx ../models/people.onnx
```

`report.json` beside the model gives exact-count and within-one accuracy by
crowd size for both the model and the rule, on 3,000 frames neither saw during
training. On the Pi the model runs through onnxruntime on one core, and
`main.py --selftest` says which counter is in use.

## Recording real frames

Optional, and only with consent.

```bash
sudo systemctl stop flock-sensor
cd ~/flock-sensor/training
python3 record.py --room kitchen --consent --note "two people, a mug"
sudo systemctl start flock-sensor
```

It records one frame a second for five minutes (`--minutes`, `--every`) and
prints what the rule makes of each one, so a session shows its own mistakes as
they happen. Every frame is a thermal image of whoever is in view, so:

- Record only in places you control, never at a venue. A venue unit does not
  have this tool: `setup.sh` does not install it, and `main.py` keeps no frame.
- Everyone in view agrees first, and a parent agrees for anyone under 18. No
  microphone is involved.
- Nothing private in view: no bedroom or bathroom while in use.
- Frames never go into this repository (`*.frames` is ignored) or any public
  place. Copy them off the Pi and delete them there.
- Keep a note of which sessions trained which model, so anyone who asks can
  have their sessions deleted and the model retrained without them.
