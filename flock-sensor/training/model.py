"""The sensor's network: a thermal frame in, what is in it out.

Input is the two channels from synth.model_input, 2 x 120 x 160. Output, on a
30 x 40 grid a quarter of the frame's resolution:

  heat  one map per class in synth.CLASSES, a peak at every thing of that
        kind. Class 0 is people, and counting people is finding its peaks,
        which main.py does without torch.
  ltrb  at each peak, how far the thing's box reaches left, up, right and
        down from the peak, in grid cells, so the screen can draw it.

It names kinds of things. It has no way to tell one person from another and
nothing about it follows anybody from one frame to the next: every frame is
read on its own and forgotten.

It is small on purpose. The Pi 5 runs it on one CPU core several times a
second, and the frame is small: a head at the far side of a room is a handful
of pixels, so depth buys little and a wide view of the frame buys a lot (a hand
filling half of it has to be seen as one hand, not five warm blobs).

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
    def __init__(self, w=24, classes=1, boxes=False, stride=4):
        super().__init__()
        self.classes, self.boxes, self.stride = classes, boxes, stride
        self.s2 = nn.Sequential(block(2, w, 2), block(w, w))                   # 60x80
        self.s4 = nn.Sequential(block(w, w * 2, 2), Res(w * 2))                # 30x40
        self.s8 = nn.Sequential(block(w * 2, w * 3, 2), Res(w * 3), Res(w * 3))  # 15x20
        self.s16 = nn.Sequential(block(w * 3, w * 4, 2), Res(w * 4, 2), Res(w * 4, 2))  # 8x10
        self.up16 = nn.Conv2d(w * 4, w * 3, 1)
        self.up8 = nn.Conv2d(w * 3, w * 2, 1)
        self.fuse = nn.Sequential(block(w * 2, w * 2), block(w * 2, w))
        if stride == 2:
            # A second, finer output grid (80 x 60): two heads a few pixels
            # apart fall in one cell of the 40 x 30 grid and merge into one
            # person, which is how crowds and one person behind another were
            # undercounted. The finer grid takes the stride-2 features back in.
            self.fine_skip = block(w, w)
            self.fine = block(w, w)
        self.head = nn.Conv2d(w, classes, 1)
        # Start from "nothing here" so early training is not a flood of peaks.
        nn.init.constant_(self.head.bias, -4.6)
        if boxes:
            self.box = nn.Sequential(block(w, w), nn.Conv2d(w, 4, 1))

    def forward(self, x):
        a = self.s2(x)
        b = self.s4(a)
        c = self.s8(b)
        d = self.s16(c)
        c = c + F.interpolate(self.up16(d), size=c.shape[-2:], mode='bilinear', align_corners=False)
        b = b + F.interpolate(self.up8(c), size=b.shape[-2:], mode='bilinear', align_corners=False)
        f = self.fuse(b)
        if self.stride == 2:
            f = F.interpolate(f, size=a.shape[-2:], mode='bilinear', align_corners=False)
            f = self.fine(f + self.fine_skip(a))
        if not self.boxes:
            return self.head(f)                   # logits, classes x 30 x 40
        # Box reach is learned in log space: a hand filling half the frame and
        # a head across the room differ fiftyfold in size.
        return self.head(f), self.box(f)


def focal_loss(logits, target, alpha=2.0, beta=4.0, known=None):
    """CenterNet's penalty-reduced focal loss over a Gaussian target.

    known, [N, classes] of 0 or 1, says which maps a frame's labels cover. A
    real frame from a public dataset marks its people and nothing else, so its
    other maps are neither right nor wrong and must not be graded.
    """
    p = torch.sigmoid(logits).clamp(1e-4, 1 - 1e-4)
    pos = target.eq(1.0).float()
    neg = 1.0 - pos
    pos_loss = torch.log(p) * (1 - p) ** alpha * pos
    neg_loss = torch.log(1 - p) * p ** alpha * (1 - target) ** beta * neg
    if known is not None:
        w = known[:, :, None, None]
        pos, pos_loss, neg_loss = pos * w, pos_loss * w, neg_loss * w
    n = pos.sum().clamp(min=1.0)
    return -(pos_loss.sum() + neg_loss.sum()) / n


def box_loss(raw, ltrb, mask):
    """L1 in log space on the box reach, at object peaks only."""
    m = mask.unsqueeze(1)
    n = m.sum().clamp(min=1.0)
    return (torch.abs(raw - torch.log1p(ltrb)) * m).sum() / (4 * n)
