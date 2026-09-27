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

Computer-generated thermal frames, made by `synth.py`, and nothing else. No
photograph or recording of a real person is used. Each frame is a room at some
temperature with people at every distance and pose, drawn the way this camera
sees them: 160 x 120 pixels across 57 degrees, radiometric Celsius, soft edges,
lens blur, sensor noise and the few degrees of error an uncalibrated Lepton
has. Mixed in are the things that fool a threshold: a hand held up to the lens,
fingers spread, a hot mug, a laptop, a radiator, a lamp, a pet, a warm seat
somebody just left. Every person gets one label point; a hand reaching in from
outside the frame, a pet or a mug gets none.

Because the frames are generated, the model never sees the same one twice and
there is nothing on disk to protect.

The limit is honest to state: a model trained only on drawn frames can meet
something in a real room that no drawing had. The screen on a demo unit rings
every person the model found, so a miss shows up the moment it happens, and
`record.py` exists for the day real frames are worth adding.

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
