# Training the people counter

Today the sensor counts people in a thermal frame with a hand-written rule:
average the frame into 4 x 4 pixel cells, mark the warm ones, and count the
warm regions big enough to be a head. The rule has no idea what a person looks
like. A hand close to the lens is a region, so it counts; spread fingers can be
two regions, so they count twice; two people packed together can be one.
Telling those apart is shape recognition, which a small trained model does and
a threshold cannot.

The plan is a model that marks where each head is, trained on frames from this
camera. Published work on thermal people counting found that approach the most
accurate for counting, and that models trained on other cameras' thermal images
transfer poorly, so the training data has to come from this one. The rule stays
as the fallback whenever there is no model.

## What is here

| File | Runs on | What it does |
|---|---|---|
| `record.py` | the Pi | Records frames from the thermal camera into `~/flux-training/<room>/` |
| `frames.py` | both | The file format: one session per file, one frame per line |

## Recording

```bash
sudo systemctl stop flock-sensor
cd ~/flock-sensor/training
python3 record.py --room kitchen --consent --note "two people, a mug"
sudo systemctl start flock-sensor
```

It records one frame a second for five minutes (`--minutes`, `--every`) and
prints what today's counter makes of each one, so a session shows its own
mistakes as they happen.

What makes a model that works in a room it has never seen, per room:

- **Several short sessions,** at different times of day, with the heating and
  the light as they really are.
- **People doing everything:** near and far, standing, sitting, walking
  through, two or three close together, one half out of view.
- **Everything that fools the counter today:** a hand close to the lens, a mug
  of something hot, a laptop, a pet, a seat somebody just left.
- **The room with nobody in it,** at the start and the end of each session.
- **More than one room.** One whole room is kept out of training and used only
  to test, which is the only honest measure of how the model will do in a venue
  it has never seen.

## Consent, and where the frames live

Every frame is a thermal image of whoever is in view, so:

- Record only in places you control, never at a venue. A venue unit does not
  have this tool: `setup.sh` does not install it, and `main.py` keeps no frame.
- Everyone in view signs the consent sheet first, and a parent signs for anyone
  under 18. No microphone is involved.
- Nothing private in view: no bedroom or bathroom while in use.
- Frames never go into this repository (`*.frames` is ignored) or any public
  place. Copy them off the Pi and delete them there.
- Keep a note of which sessions trained which model, so anyone who asks can
  have their sessions deleted and the model retrained without them.
