import onnxruntime as ort
import numpy as np
import json

sess = ort.InferenceSession('crowd_model.onnx')
input_name = sess.get_inputs()[0].name
print(f'ONNX input: {input_name}, shape: {sess.get_inputs()[0].shape}')

meta = json.loads(open('model_metadata.json').read())
cols = meta['feature_names']
print(f'Feature count: {len(cols)}')
print(f'Model version: {meta["model_version"]}')
print(f'Label type: {meta["label_type"]}')
print(f'Delta clamp: {meta["delta_clamp_range"]}')

def idx(name):
    return cols.index(name)

def make_vec(hour, dow, category_baseline, refined_baseline, is_weekend=0, is_realtime=0, is_raining=0):
    v = np.zeros(95, dtype=np.float32)
    v[idx('hour')] = hour
    v[idx('day_of_week')] = dow
    v[idx('hour_sin')] = np.sin(2*np.pi*hour/24)
    v[idx('hour_cos')] = np.cos(2*np.pi*hour/24)
    v[idx('dow_sin')] = np.sin(2*np.pi*dow/7)
    v[idx('dow_cos')] = np.cos(2*np.pi*dow/7)
    v[idx('category_baseline')] = category_baseline
    v[idx('refined_category_baseline')] = refined_baseline
    v[idx('is_weekend')] = is_weekend
    v[idx('is_realtime')] = is_realtime
    v[idx('is_raining')] = is_raining
    v[idx('temperature')] = 20
    v[idx('humidity')] = 60
    v[idx('rating')] = 4.3
    v[idx('price_level')] = 2
    v[idx('weather_clear')] = 1
    v[idx('venue_category_encoded')] = 0
    return v

test_cases = [
    ('Quiet weekday bar 11am', 11, 1, 15, 18, 30),
    ('Busy Friday bar 10pm',   22, 5, 80, 85, 75),
    ('Sunday brunch cafe 11am', 11, 0, 55, 60, 60),
    ('Dead Tue gym 3am',        3, 2, 5, 3, 2),
    ('Edge: baseline=0',        20, 5, 0, 0, 0),
]

print()
print(f'{"Scenario":35s} | baseline | delta  | absolute (clamped) | sane?')
print('-' * 95)
for name, hour, dow, catb, refb, baseline in test_cases:
    v = make_vec(hour, dow, catb, refb, is_weekend=1 if dow in (0,6) else 0)
    out = sess.run(None, {input_name: v.reshape(1, -1)})[0]
    raw = float(np.asarray(out).flatten()[0])
    clamped = max(-30, min(30, raw))
    absolute = max(0, min(100, baseline + clamped))
    sane = 'YES' if 0 <= absolute <= 100 else 'NO'
    print(f'{name:35s} | {baseline:8d} | {raw:+6.2f} | {absolute:18.1f} | {sane}')
