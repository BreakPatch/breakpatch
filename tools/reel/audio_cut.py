import numpy as np, wave
from scipy import signal as sg

import json, sys
sr = 44100
REC = json.load(open(sys.argv[1])); OUT = sys.argv[2]
CRAWL = 0.04
# timeline mirrors the video's setCut() exactly
TL = []; SEAMS = []; _c = 0.0
for _si, (_m0, _m1) in enumerate(REC['segments']):
    if _si > 0 and abs(REC['segments'][_si - 1][1] - _m0) > 1e-6: SEAMS.append(_c)
    _hs = sorted([h for h in REC.get('holds', []) if _m0 <= h[0] < _m1])
    _cur = _m0
    for _hm, _shift in _hs:
        _d = _shift / (1 - CRAWL)
        if _hm > _cur + 1e-9: TL.append((_c, _c + (_hm - _cur), _cur, _hm, False)); _c += _hm - _cur
        _end = _hm + CRAWL * _d; TL.append((_c, _c + _d, _hm, _end, True)); _c += _d; _cur = _end
    TL.append((_c, _c + (_m1 - _cur), _cur, _m1, False)); _c += _m1 - _cur
DUR = _c
N = int(sr * (DUR + 2.5))
def M(t):
    """master time -> cut time (None when this moment isn't in the cut)"""
    for c0, c1, m0, m1, hold in TL:
        if not hold and m0 - 1e-9 <= t <= m1 + 1e-9: return c0 + (t - m0)
    for c0, c1, m0, m1, hold in TL:
        if hold and m0 < t <= m1: return c1
    return None
def section(a, b):
    """master range -> list of cut ranges (cs, ce)"""
    out = []
    for si, (m0, m1) in enumerate(REC['segments']):
        lo, hi = max(a, m0), min(b, m1)
        if hi - lo > 1e-6:
            cs = M(lo); ce = M(hi)
            # M(hi) is the first match; if hi sits at the end of a segment, take the last run entry that ends there
            for c0, c1, mm0, mm1, hold in TL:
                if not hold and abs(mm1 - hi) < 1e-6 and mm0 >= m0 - 1e-6: ce = c1
            if cs is not None and ce is not None and ce > cs: out.append((cs, ce))
    return out
rng = np.random.default_rng(7)

BEAT = 0.5

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def tt(d): return np.arange(int(d * sr)) / sr
def noise(d): return rng.standard_normal(int(d * sr))
def hp(x, f, o=2): return sg.sosfilt(sg.butter(o, f, 'hp', fs=sr, output='sos'), x)
def lp(x, f, o=2): return sg.sosfilt(sg.butter(o, f, 'lp', fs=sr, output='sos'), x)
def bp(x, f0, f1, o=2): return sg.sosfilt(sg.butter(o, [f0, f1], 'bp', fs=sr, output='sos'), x)

# busses: music (sidechained), drums, fx ; plus reverb sends
class Bus:
    def __init__(s): s.L = np.zeros(N); s.R = np.zeros(N)
bus = {k: Bus() for k in ['music', 'drums', 'fx']}
rev = Bus()

def putc(b, sig, t0, g=1.0, pan=0.0, send=0.0):
    i = int(t0 * sr)
    if i >= N or i < 0: return
    n = min(len(sig), N - i)
    s = sig[:n] * g
    a = (pan + 1) * np.pi / 4
    l, r = np.cos(a), np.sin(a)
    bus[b].L[i:i + n] += s * l; bus[b].R[i:i + n] += s * r
    if send:
        rev.L[i:i + n] += s * l * send; rev.R[i:i + n] += s * r * send

# ---------- voices ----------
def saw(f, t, maxh=40):
    K = int(min(maxh, 9000 / f)); out = np.zeros_like(t)
    for k in range(1, K + 1): out += np.sin(2 * np.pi * k * f * t) / k
    return out * (2 / np.pi)

def kick(d=.5):
    t = tt(d); f = 42 + 130 * np.exp(-t * 32)
    s = np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 7.5)
    s += noise(d) * np.exp(-t * 500) * .25
    return np.tanh(s * 1.8) * .95

def sub_boom(d=3.2):
    t = tt(d); f = 30 + 55 * np.exp(-t * 2.2)
    s = np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 1.1)
    s += lp(noise(d), 180) * np.exp(-t * 3) * 1.6
    return np.tanh(s * 1.4)

def clap(d=.35):
    t = tt(d); n = bp(noise(d), 1000, 5200)
    env = np.exp(-t * 18) * .6
    for o in (0, .011, .022): env += np.exp(-np.clip(t - o, 0, None) * 160) * (t >= o) * .8
    return n * env * 1.4

def snare(d=.3):
    t = tt(d); n = hp(noise(d), 1500) * np.exp(-t * 22)
    return (n * .9 + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * .6)

def hat(openh=False, d=None):
    d = d or (.3 if openh else .06); t = tt(d)
    return hp(noise(d), 7500) * np.exp(-t * (14 if openh else 70)) * .5

def crash(d=3.2):
    t = tt(d); return hp(noise(d), 3200) * np.exp(-t * 1.5) * .7

def riser(d, f0=250, f1=4000):
    t = tt(d); env = (t / d) ** 2.2
    n = hp(noise(d), 1800) * env * .7
    f = f0 * (f1 / f0) ** (t / d)
    s = np.sin(2 * np.pi * np.cumsum(f) / sr) * env * .25 + np.sin(2 * np.pi * np.cumsum(f * 1.5) / sr) * env * .1
    return n + s

def whoosh(d=.7, f0=300, f1=7000, up=True):
    n = noise(d); out = np.zeros_like(n); B = 1024
    for i in range(0, len(n) - B, B):
        p = i / len(n); p = p if up else 1 - p
        f = f0 * (f1 / f0) ** p
        out[i:i + B] = bp(n[i:i + B + 0], f * .6, min(f * 1.6, 20000), 2)[:B]
    env = np.sin(np.pi * np.linspace(0, 1, len(n))) ** 1.5
    return out * env * 2.2

def pad(notes, d, cut=1400):
    t = tt(d); s = np.zeros_like(t)
    for m in notes:
        for c in (-8, 0, 8): s += saw(hz(m) * 2 ** (c / 1200), t, 20)
    s = lp(s, cut)
    env = np.minimum(1, t / .5) * np.minimum(1, (d - t) / .6)
    return s * env * .1

def pluck(m, d=.4, cut=4200):
    t = tt(d); f = hz(m)
    s = saw(f, t, 24) + .5 * saw(f * 2.003, t, 10)
    s = lp(s, cut) * np.exp(-t * 9)
    return s * .35

def bassn(m, d=.5, cut=420):
    t = tt(d); f = hz(m)
    s = saw(f, t, 12) * .6 + np.sin(2 * np.pi * f * t) * .9
    s = lp(s, cut) * np.minimum(1, (d - t) / .05) * np.minimum(1, t / .004)
    return np.tanh(s * 1.4) * .7

def thunk():
    t = tt(.3); f = 50 + 60 * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 14) * .9 + hp(noise(.3), 2500) * np.exp(-t * 200) * .3

def blip(f0, f1, d=.12, g=.4):
    t = tt(d); f = f0 * (f1 / f0) ** (t / d)
    return np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 22) * g

def bell(m, d=1.8):
    t = tt(d); f = hz(m); s = np.zeros_like(t)
    for r, a in [(1, 1), (2.76, .5), (5.4, .25), (8.9, .12)]: s += np.sin(2 * np.pi * f * r * t) * a * np.exp(-t * (2.5 + r))
    return s * .35

# ---------- chords ----------
CH = [([57, 60, 64], 45), ([53, 57, 60], 41), ([60, 64, 67], 48), ([55, 59, 62], 43)]  # Am F C G
def chord(t): return CH[int(t // 2) % 4]

kick_times = []
def K(t, g=1.0):
    put('drums', kick(), t, g); kick_times.append(t)



def put(b, sig, t0, g=1.0, pan=0.0, send=0.0):
    c = M(t0)
    if c is not None: putc(b, sig, c, g, pan, send)

# ---------- extra voices ----------
def glass(d=1.6):
    t = tt(d); n = hp(noise(d), 2500) * np.exp(-t * 6) * .9
    for k in range(34):
        f = rng.uniform(1800, 9000); st = rng.uniform(0, .5); tk = t - st; m = tk > 0
        n[m] += np.sin(2 * np.pi * f * tk[m]) * np.exp(-tk[m] * rng.uniform(10, 26)) * rng.uniform(.05, .2)
    return n
def tick(g=1.0, f=3200):
    t = tt(.02); return (np.sin(2 * np.pi * f * t) * .4 + hp(noise(.02), 4000) * .6) * np.exp(-t * 260) * g
def woodblock(f=900):
    t = tt(.18); return (np.sin(2 * np.pi * f * t) + .4 * np.sin(2 * np.pi * f * 2.3 * t)) * np.exp(-t * 28) * .5
def buzz(d=.6):
    t = tt(d); s = np.tanh(saw(55, t, 30) * 4) * np.exp(-t * 4) + hp(noise(d), 800) * np.exp(-t * 10) * .4
    gl = (np.floor(t * 40) % 3 == 0); return s * (1 - .6 * gl) * .8
def uiclick():
    t = tt(.09); return (np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 120) * .5 + hp(noise(.09), 3500) * np.exp(-t * 170) * .3)
def marimba(m, d=.6):
    t = tt(d); f = hz(m)
    return (np.sin(2 * np.pi * f * t) + .5 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t * 30)) * np.exp(-t * 7) * .5

kick_times = []
def K(t, g=1.0):
    c = M(t)
    if c is None: return
    putc('drums', kick(), c, g); kick_times.append(c)
def Kc(c, g=1.0):
    putc('drums', kick(), c, g); kick_times.append(c)

def groove_c(c0, c1, claps=False, hats16=False, arp='8th', arp_oct=12, bassg=.8, arpg=1.0, kicks=True):
    t = c0
    while t < c1 - 1e-6:
        notes, root = chord(t)
        if kicks: Kc(t, 1.0)
        putc('drums', hat(True), t + .25, .4)
        if hats16:
            for j in (0, .125, .375): putc('drums', hat(False), t + j, .26)
        if claps and int(round((t % 2) / BEAT)) in (1, 3):
            putc('drums', clap(), t, .75); putc('drums', snare(), t, .3)
        putc('music', bassn(root, .22), t + .25, bassg * .9); putc('music', bassn(root, .2), t, bassg * .9)
        if arp:
            seq = notes + [notes[0] + 12, notes[1] + 12, notes[2] + 12]
            if arp == '8th':
                for j in range(2): putc('music', pluck(seq[(int(t / BEAT) * 2 + j) % 6] + arp_oct, .4), t + j * .25, arpg * (1 if j == 0 else .7), (-.4 if j else .4), .35)
            else:
                for j in range(4): putc('music', pluck(seq[(int(t / BEAT) * 4 + j * 2 + (j // 2)) % 6] + arp_oct, .3), t + j * .125, arpg * (1 if j == 0 else .6), (-.5 if j % 2 else .5), .3)
        t += BEAT
def pads_c(c0, c1, up=0, cut=2200, g=1.0):
    t = c0
    while t < c1 - 1e-6:
        b0 = (t // 2) * 2; ln = min(b0 + 2, c1) - t
        notes, root = chord(t)
        putc('music', pad([n + up for n in notes], ln + .5, cut), t, g, send=.35); t = b0 + 2
def G(a, b, **kw):
    pk = {k: kw.pop(k) for k in ('up', 'cut', 'pg') if k in kw}
    for cs, ce in section(a, b):
        pads_c(cs, ce, pk.get('up', 0), pk.get('cut', 2400), pk.get('pg', 1.0)); groove_c(cs, ce, **kw)

# ================= ARRANGEMENT (master time; mapped into each cut) =================
if REC.get('drone'):
    putc('music', pad([45, 52, 57, 60], 4.5, 900), 0, 1.1, send=.4); putc('music', bassn(33, 4.0, 200), 0, .5)
# --- 0-2 : the app works (calm) ---
put('music', pad([45, 52, 57, 60], 4.0, 900), 0, 1.1, send=.4)
put('music', bassn(33, 2.0, 200), 0, .5)
put('fx', bell(81, 2.0), .3, .5, .2, .6)
for i in range(4): put('drums', tick(.35, 2400), .5 + i * .5)
put('fx', uiclick(), 1.2, .9, .3); put('fx', blip(500, 1100, .12, .3), 1.36, 1, .2, .2)
put('fx', marimba(76), 1.38, .5, .2, .3)
put('fx', riser(.3, 400, 6000), 1.72, .8, 0, .2)
# --- 2 : it breaks ---
put('fx', glass(2.0), 2.0, 1.1, 0, .5); put('drums', sub_boom(2.4), 2.0, .9); K(2.0, 1.1)
put('music', pad([n - 12 for n in CH[1][0]], 2.4, 700), 2.0, 1.3, send=.5)
put('music', bassn(29, 2.0, 180), 2.0, .8)
for t_ in (2.5, 3.0, 3.5): put('drums', thunk(), t_, .9)
for i in range(8): put('drums', hat(False, .03), 3.0 + i * .125, .15 + .04 * i)
put('fx', blip(900, 200, .3, .3), 2.5, 1, -.3, .2)
put('fx', whoosh(.8, 300, 5000, True), 3.3, .5, 0, .3)
# --- 4-6 : build ---
put('music', pad([n for n in CH[2][0]], 2.4, 1600), 4.0, 1.2, send=.4)
put('music', bassn(36, 2.0, 220), 4.0, .7)
put('fx', riser(1.9, 220, 5200), 4.1, 1.0, 0, .3)
rc = crash(1.9)[::-1]; put('fx', rc * np.linspace(0, 1, len(rc)) ** 2, 4.1, .9, 0, .2)
for i in range(4): K(4.0 + i * .5, .4 + .12 * i)
sr_t = 5.0; step = .25
while sr_t < 5.92:
    put('drums', snare(), sr_t, .3 + (sr_t - 5) * .5); sr_t += step; step = max(.04, step * .84)
for i in range(6): put('drums', hat(False, .03), 4.0 + i * .33, .2)
# --- 6 : DROP (logo) ---
put('drums', sub_boom(), 6.0, 1.0); K(6.0, 1.25); put('fx', crash(), 6.0, 1.0, 0, .35)
put('fx', whoosh(1.2, 8000, 300, False), 6.0, .6, 0, .3)
put('music', pad([57, 60, 64, 76], 3.6, 3500), 6.0, 1.6, send=.45)
put('fx', bell(81, 3), 6.0, .9, .2, .6); put('fx', bell(76, 3), 6.08, .6, -.2, .6); put('fx', bell(88, 2.5), 6.7, .4, .5, .6)
G(6, 8, arp='8th', arp_oct=12, arpg=.85, pg=1.2, cut=3000)
put('fx', whoosh(.6, 400, 10000, True), 7.5, .9, 0, .3)
# --- 8-14 : recorder ---
G(8, 14, claps=True, hats16=True, arp='8th', arp_oct=12, arpg=.8, pg=1.1, cut=2600)
put('fx', crash(1.8), 8.0, .5, 0, .3)
for i in range(28): put('drums', tick(.22, rng.uniform(2800, 3800)), 8.9 + i / 18 + rng.uniform(0, .02))
put('fx', blip(600, 1400, .12, .3), 10.5, 1, 0, .2)
put('fx', whoosh(.6, 300, 5200, True), 10.5, .7, 0, .3)
put('fx', bell(88, 1.6), 11.1, .55, .2, .5); put('fx', bell(93, 1.6), 11.14, .4, -.2, .5)
put('fx', marimba(81), 11.3, .6, .1, .3)
put('fx', uiclick(), 11.98, 1.0, .2); put('drums', clap(), 12.0, .7); put('fx', sub_boom(1.0), 12.0, .5)
for t_, m in [(12.05, 69), (12.6, 76), (12.85, 81)]: put('fx', marimba(m + 12), t_, .8, np.sin(t_) * .4, .3)
put('fx', uiclick(), 12.6, .5, -.2)
put('fx', bell(93, 1.4), 13.5, .5, 0, .5)
put('fx', whoosh(.7, 300, 11000, True), 13.35, 1.0, 0, .3)
# --- 14-18 : on-device ---
G(14, 18, claps=True, hats16=True, arp='16th', arp_oct=24, arpg=.55, bassg=.9, up=12, cut=3400, pg=.9)
put('fx', crash(1.6), 14.0, .5, 0, .3); put('fx', sub_boom(1.2), 14.0, .6)
for i, t_ in enumerate((14.5, 15.0, 15.5, 16.0)):
    put('fx', woodblock(700 + i * 160), t_ + .05, .9, (i - 1.5) * .3, .2); put('fx', marimba(76 + i * 3), t_, .5, 0, .2)
put('fx', bell(93, 2.5), 16.0, .6, 0, .6); put('fx', bell(81, 2.5), 16.0, .5, 0, .6)
put('fx', whoosh(.7, 300, 11000, True), 17.35, 1.0, 0, .3)
# --- 18-22 : replay / fail ---
G(18, 19.5, claps=True, hats16=True, arp='16th', arp_oct=12, arpg=.7, cut=2400)
G(20, 21.5, claps=True, hats16=True, arp='8th', arp_oct=12, arpg=.6, bassg=.7, cut=2400)
put('fx', crash(1.4), 18.0, .55, 0, .3); put('fx', sub_boom(1.4), 18.0, .8)
for i, m in enumerate([69, 72, 76, 79, 81]):
    put('fx', marimba(m + 12), 18.65 + i * .2, .8, (i - 2) * .25, .3); put('drums', tick(.3), 18.65 + i * .2)
put('fx', riser(.35, 200, 3000), 19.4, .8, 0, .2)
put('fx', buzz(.7), 19.75, 1.0, 0, .3); put('fx', blip(700, 90, .35, .45), 19.75, 1, 0, .2); put('drums', sub_boom(1.5), 19.75, .9)
for k in range(4): put('fx', hp(noise(.04), 3000) * np.exp(-tt(.04) * 80) * .4, 19.78 + k * .05, 1, rng.uniform(-.8, .8))
put('drums', sub_boom(1.2), 20.0, .6)
put('drums', thunk(), 20.45, .9); put('fx', marimba(64), 20.95, .8, 0, .3); put('fx', marimba(69), 21.05, .6, 0, .3)
put('fx', uiclick(), 21.4, 1.0, .1); put('fx', bell(96, 1.6), 21.45, .6, 0, .5)
put('fx', whoosh(.7, 300, 11000, True), 21.35, 1.0, 0, .3)
# --- 22-26 : Team ---
G(22, 26, claps=True, hats16=True, arp='16th', arp_oct=24, arpg=.7, up=12, cut=3600)
put('fx', crash(1.6), 22.0, .55, 0, .3); put('fx', sub_boom(1.6), 22.0, .8)
put('fx', whoosh(.5, 300, 6000, True), 22.75, .7, 0, .3)
put('fx', bell(88, 1.6), 23.1, .6, .2, .5)
for i, m in enumerate([76, 79, 83, 88, 91, 95]): put('fx', bell(m, .8), 23.3 + i * .06, .45, np.sin(i) * .6, .5)
put('fx', uiclick(), 23.85, .9, 0)
for t_ in (24.0, 24.5, 25.0):
    put('fx', whoosh(.4, 600, 8000, True), t_ - .2, .6, 0, .2); put('fx', woodblock(1000), t_ + .02, .8, 0, .2); put('fx', marimba(81), t_, .5, 0, .2)
put('fx', crash(1.4), 24.0, .5, 0, .3); put('fx', sub_boom(1.0), 24.0, .7)
for i in range(30): put('drums', tick(.18, rng.uniform(2800, 3600)), 25.3 + i / 40)
put('fx', bell(93, 2.0), 25.8, .7, 0, .5); put('fx', bell(81, 2.0), 25.8, .5, 0, .5)
put('fx', whoosh(.7, 300, 11000, True), 25.35, 1.0, 0, .3)
# --- 26-30 : finale ---
put('fx', sub_boom(3.4), 26.0, 1.15); K(26.0, 1.3); put('fx', crash(3.4), 26.0, 1.0, 0, .4)
put('fx', whoosh(1.4, 9000, 250, False), 26.0, .6, 0, .3)
put('music', pad([45, 57, 60, 64, 71], 3.4, 3800), 26.0, 1.8, send=.6)
put('music', pad([69, 72, 76, 83], 3.2, 3000), 26.0, .9, send=.6)
put('music', bassn(33, 3.0, 300), 26.0, .9)
for i, m in enumerate([81, 88, 93, 100]): put('fx', bell(m, 3.0), 26.02 + i * .05, .7, (i - 1.5) * .4, .6)
for t_ in (26.5, 27.0, 27.5, 28.0, 28.5): K(t_, .5)
for i, tm in enumerate([27.0, 27.15, 27.3, 27.5, 27.7]): put('fx', bell([81, 84, 88, 93, 96][i], 1.6), tm, .4, (i - 2) * .3, .6)
for i in range(49): put('drums', tick(.28, rng.uniform(2600, 3600)), 27.5 + i / 44 + rng.uniform(0, .01))
put('fx', uiclick(), 28.8, 1.0, .1); put('fx', bell(96, 2.0), 28.82, .8, 0, .6); put('fx', bell(88, 2.0), 28.86, .6, 0, .6)
put('fx', sub_boom(1.5), 28.8, .5)
put('fx', marimba(88), 29.2, .6, 0, .4); put('fx', bell(81, 1.0), 29.3, .4, 0, .5)
# --- 30-36 : open source ---
G(30, 36, claps=True, hats16=True, arp='16th', arp_oct=24, arpg=.75, bassg=.9, cut=3200, pg=1.1)
put('fx', crash(2.0), 30.0, .7, 0, .3); put('fx', sub_boom(1.6), 30.0, .8); K(30.0, 1.2)
for t_, m in [(30.1, 81), (30.45, 88), (31.0, 93)]: put('fx', bell(m, 1.8), t_, .6, 0, .5)
for i in range(7): put('drums', tick(.3, 3000), 31.1 + i * .28)
for i, t_ in enumerate((32.3, 32.65, 33.0)): put('fx', woodblock(800 + i * 150), t_, .8, (i - 1) * .3, .2); put('fx', marimba(76 + i * 4), t_, .5, 0, .2)
put('drums', thunk(), 32.2, .9); put('fx', bell(93, 1.6), 32.55, .6, 0, .5)
put('fx', whoosh(.5, 300, 8000, True), 33.7, .8, 0, .3)
put('fx', sub_boom(2.4), 34.0, 1.1); K(34.0, 1.3); put('fx', crash(2.4), 34.0, .8, 0, .4); put('fx', bell(88, 2.0), 34.0, .6, 0, .5)
put('fx', sub_boom(1.6), 34.5, .8); put('fx', bell(93, 2.4), 34.5, .7, 0, .6); put('fx', bell(81, 2.4), 34.5, .5, 0, .6)
put('fx', marimba(100), 34.95, .5, 0, .4)
# --- 36-42 : Flutter web ---
G(36, 42, claps=True, hats16=True, arp='16th', arp_oct=24, arpg=.7, bassg=.9, cut=3400, pg=1.0, up=12)
put('fx', crash(1.8), 36.0, .6, 0, .3); put('fx', sub_boom(1.6), 36.0, .8); K(36.0, 1.2)
for t_ in (36.1, 36.3, 36.5): put('drums', thunk(), t_, .7)
put('fx', whoosh(.5, 300, 7000, True), 36.55, .6, 0, .3)
for i in range(41): put('drums', tick(.25, rng.uniform(2800, 3600)), 37.2 + i / 40)
put('fx', buzz(.5), 38.1, .8, 0, .3); put('fx', blip(700, 90, .3, .4), 38.1, 1, 0, .2)
put('fx', whoosh(.6, 300, 9000, True), 38.5, .8, 0, .3); put('fx', sub_boom(1.2), 38.6, .7)
put('fx', bell(88, 1.4), 38.95, .6, .2, .5)
put('fx', uiclick(), 39.3, 1.0, .1); put('fx', bell(93, 1.6), 39.32, .6, 0, .5); put('fx', bell(88, 1.6), 39.36, .5, 0, .5)
put('fx', marimba(88), 39.8, .6, 0, .3)
for i in range(6): put('fx', woodblock(700 + i * 120), 40.7 + i * .12, .8, (i - 2.5) * .25, .2); put('fx', marimba(76 + i * 2), 40.7 + i * .12, .5, 0, .2)
put('fx', bell(96, 2.0), 41.0, .6, 0, .5); put('fx', bell(84, 2.0), 41.0, .5, 0, .5)
# --- seams between non-contiguous segments ---
for s_ in SEAMS:
    putc('fx', whoosh(.45, 600, 9000, True), max(0, s_ - .4), .7, 0, .2); putc('fx', sub_boom(1.0), s_, .55); putc('fx', crash(1.2), s_, .45, 0, .3)
    Kc(s_, 1.0)

# ---------- mix ----------
def duck(n, times, depth=.65, rel=.14):
    env = np.ones(n); tarr = np.arange(n) / sr
    for tk_ in times:
        m = tarr >= tk_
        env[m] = np.minimum(env[m], 1 - depth * np.exp(-(tarr[m] - tk_) / rel))
    return env
dk = duck(N, kick_times)
for ch in ('L', 'R'): setattr(bus['music'], ch, getattr(bus['music'], ch) * dk)

# reverb: synthetic stereo IR
def make_ir(d=2.8):
    t = tt(d); ir = []
    for _ in range(2):
        n = rng.standard_normal(len(t)) * np.exp(-t * 2.6); n = lp(n, 7000); n[:int(.012 * sr)] *= np.linspace(0, 1, int(.012 * sr)); ir.append(n)
    return ir
irL, irR = make_ir()
rvL = sg.fftconvolve(rev.L, irL)[:N] * .035; rvR = sg.fftconvolve(rev.R, irR)[:N] * .035

L = bus['music'].L * .85 + bus['drums'].L * 1.0 + bus['fx'].L * .8 + rvL
R = bus['music'].R * .85 + bus['drums'].R * 1.0 + bus['fx'].R * .8 + rvR

# dip right before the drop & final fade
tarr = np.arange(N) / sr
gap = np.ones(N); _c6 = M(6.0)
if _c6 is not None: gap[(tarr >= _c6 - .07) & (tarr < _c6)] = .08
fade_in = np.minimum(1, tarr / .15); fade_out = np.clip((DUR - tarr) / .5, 0, 1)
master = gap * fade_in * fade_out
L *= master; R *= master
L = hp(L, 28, 2); R = hp(R, 28, 2)
# glue: soft clip + normalise
pk = max(np.abs(L).max(), np.abs(R).max())
L = np.tanh(L / pk * 1.6) / np.tanh(1.6); R = np.tanh(R / pk * 1.6) / np.tanh(1.6)
pk = max(np.abs(L).max(), np.abs(R).max()); L *= .89 / pk; R *= .89 / pk
n = int(DUR * sr)
pcm = (np.stack([L[:n], R[:n]], 1) * 32767).astype(np.int16)
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
print('ok', n / sr, 'peak', pk)
