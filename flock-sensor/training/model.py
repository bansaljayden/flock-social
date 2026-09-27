"""The people counter's network: a thermal frame in, a map of head points out.

Input is the two channels from synth.model_input, 2 x 120 x 160. Output is
one 30 x 40 map, a quarter of the frame's resolution, where every person is a
peak. Counting is finding the peaks, which main.py does without torch.

It is small on purpose. The Pi 5 runs it on one CPU core between frames, and
the frame is small: a head at the far side of a room is a handful of pixels, so
depth buys little and a wide view of the frame buys a lot (a hand filling half
of it has to be seen as one hand, not five warm blobs).

Training needs torch. The sensor never imports this file; it loads the ONNX
export instead.
"""

import torch
from torch import nn
import torch.nn.functional as F


def block(cin, cout, stride=1):
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, stride, 1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
    )


class Res(nn.Module):
    def __init__(self, ch, dilation=1):
        super().__init__()
        self.a = nn.Conv2d(ch, ch, 3, 1, dilation, dilation=dilation, bias=False)
        self.an = nn.BatchNorm2d(ch)
        self.b = nn.Conv2d(ch, ch, 3, 1, 1, bias=False)
        self.bn = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = F.relu(self.an(self.a(x)), inplace=True)
        return F.relu(x + self.bn(self.b(y)), inplace=True)


class PeopleNet(nn.Module):
    def __init__(self, w=24):
        super().__init__()
        self.s2 = nn.Sequential(block(2, w, 2), block(w, w))                   # 60x80
        self.s4 = nn.Sequential(block(w, w * 2, 2), Res(w * 2))                # 30x40
        self.s8 = nn.Sequential(block(w * 2, w * 3, 2), Res(w * 3), Res(w * 3))  # 15x20
        self.s16 = nn.Sequential(block(w * 3, w * 4, 2), Res(w * 4, 2), Res(w * 4, 2))  # 8x10
        self.up16 = nn.Conv2d(w * 4, w * 3, 1)
        self.up8 = nn.Conv2d(w * 3, w * 2, 1)
        self.fuse = nn.Sequential(block(w * 2, w * 2), block(w * 2, w))
        self.head = nn.Conv2d(w, 1, 1)
        # Start from "nobody here" so early training is not a flood of peaks.
        nn.init.constant_(self.head.bias, -4.6)

    def forward(self, x):
        a = self.s2(x)
        b = self.s4(a)
        c = self.s8(b)
        d = self.s16(c)
        c = c + F.interpolate(self.up16(d), size=c.shape[-2:], mode='bilinear', align_corners=False)
        b = b + F.interpolate(self.up8(c), size=b.shape[-2:], mode='bilinear', align_corners=False)
        return self.head(self.fuse(b))           # logits, 1 x 30 x 40


def focal_loss(logits, target, alpha=2.0, beta=4.0):
    """CenterNet's penalty-reduced focal loss over a Gaussian target."""
    p = torch.sigmoid(logits).clamp(1e-4, 1 - 1e-4)
    pos = target.eq(1.0).float()
    neg = 1.0 - pos
    pos_loss = torch.log(p) * (1 - p) ** alpha * pos
    neg_loss = torch.log(1 - p) * p ** alpha * (1 - target) ** beta * neg
    n = pos.sum().clamp(min=1.0)
    return -(pos_loss.sum() + neg_loss.sum()) / n
