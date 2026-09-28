import asyncio

import numpy as np

from breakpatch_engine import checks, imaging
from breakpatch_engine.locator import map_box, parse_bbox, parse_describe


def canvas(w=400, h=300, color=(240, 240, 240)):
    a = np.zeros((h, w, 3), np.uint8)
    a[:] = color
    return a


def rect(a, box, color=(30, 90, 200)):
    x1, y1, x2, y2 = box
    a[y1:y2, x1:x2] = color
    return a


def button(a, x, y):
    """A 'button' with a label-like, asymmetric pattern (perfectly symmetric flat crops make phash
    coefficients tie at the median, which real antialiased UI rarely does)."""
    rect(a, [x, y, x + 60, y + 30], (40, 40, 40))
    for i, (w, dy) in enumerate([(22, 8), (9, 8), (30, 16), (14, 21)]):
        rect(a, [x + 6 + i * 3, y + dy, x + 6 + i * 3 + w, y + dy + 3], (250, 250, 250))
    return a


def test_hash_is_16_hex_and_stable():
    a = button(canvas(), 100, 100)
    h1 = imaging.region_hash(a, [90, 90, 170, 140])
    h2 = imaging.region_hash(a.copy(), [90, 90, 170, 140])
    assert len(h1) == 16 and int(h1, 16) >= 0
    assert imaging.distance(h1, h2) == 0


def test_distance_small_for_same_content_large_when_moved():
    a = button(canvas(), 100, 100)
    rng = np.random.default_rng(1)
    b = np.clip(a.astype(int) + rng.integers(-2, 3, a.shape), 0, 255).astype(np.uint8)   # rendering jitter
    moved = button(canvas(), 250, 200)
    region = [85, 85, 175, 145]
    h = imaging.region_hash(a, region)
    assert imaging.distance(h, imaging.region_hash(b, region)) <= 6
    assert imaging.distance(h, imaging.region_hash(moved, region)) > 10


def test_ignore_zones_are_blanked_before_hashing():
    a = button(canvas(), 100, 100)
    b = button(canvas(), 100, 100)
    rect(b, [100, 100, 130, 130], (255, 0, 0))   # e.g. a clock inside the region
    region = [85, 85, 175, 145]
    ignore = [[100, 100, 130, 130]]
    assert imaging.distance(imaging.region_hash(a, region), imaging.region_hash(b, region)) > 0
    assert imaging.distance(imaging.region_hash(a, region, ignore), imaging.region_hash(b, region, ignore)) == 0


def test_hex_distance_counts_bits():
    assert imaging.distance("0" * 16, "0" * 15 + "f") == 4
    assert imaging.distance("ffffffffffffffff", "0000000000000000") == 64


def test_merge_boxes_and_union():
    boxes = imaging.merge_boxes([[0, 0, 10, 10], [5, 5, 20, 20], [100, 100, 110, 110]])
    assert boxes == [[0, 0, 20, 20], [100, 100, 110, 110]]
    assert imaging.union_box(boxes) == [0, 0, 110, 110]
    assert imaging.merge_boxes([[0, 0, 10, 10], [14, 0, 20, 10]], gap=5) == [[0, 0, 20, 10]]


def test_blast_radius_finds_changed_area_padded():
    before = canvas()
    after = rect(canvas(), [200, 150, 260, 190])   # a dialog appears
    box = imaging.blast_radius(before, after, pad=16)
    assert box == [184, 134, 276, 206]
    assert imaging.blast_radius(before, before.copy()) is None


def test_blast_radius_excludes_noise_and_merges_nearby_changes():
    before = canvas()
    after = canvas()
    rect(after, [50, 50, 70, 70])
    rect(after, [80, 50, 100, 70])       # close by: merged
    rect(after, [350, 10, 390, 30])      # the clock, ignored
    box = imaging.blast_radius(before, after, ignore=[[340, 0, 400, 40]], pad=10)
    assert box == [40, 40, 110, 80]


def test_noise_boxes_from_frames():
    frames = []
    for i in range(5):
        a = canvas()
        rect(a, [10 + i * 5, 10, 30 + i * 5, 20], (0, 0, 0))   # moving spinner
        frames.append(a)
    boxes = imaging.noise_boxes(frames, pad=4)
    assert len(boxes) == 1
    x1, y1, x2, y2 = boxes[0]
    assert x1 <= 10 and x2 >= 50 and y1 <= 10 and y2 >= 20
    assert imaging.noise_boxes([canvas(), canvas()]) == []


class FakeScreen:
    """Frames on demand: animates for `busy` shots, then stays still. A clock ticks at the corner."""

    def __init__(self, busy=4, clock=True):
        self.n = 0
        self.busy = busy
        self.clock = clock

    async def shoot(self):
        self.n += 1
        a = canvas()
        if self.clock:
            rect(a, [350, 5, 395, 25], ((self.n * 40) % 255, 0, 0))
        if self.n <= self.busy:
            rect(a, [100 + self.n * 10, 100, 140 + self.n * 10, 140])
        else:
            rect(a, [100, 200, 200, 250])
        return a


async def test_watch_noise_marks_regions_that_change_by_themselves():
    scr = FakeScreen(busy=0)
    boxes, last = await checks.watch_noise(scr.shoot, duration=0.1, interval=0.01)
    assert len(boxes) == 1
    assert imaging.overlaps(boxes[0], [350, 5, 395, 25])
    assert last.shape == (300, 400, 3)


async def test_settle_waits_for_identical_frames_excluding_ignore():
    scr = FakeScreen(busy=4)
    frame, settled = await checks.settle(scr.shoot, [[340, 0, 400, 30]], interval=0.001, frames=3, timeout=2)
    assert settled
    assert scr.n >= 4 + 3
    assert frame[225, 150].tolist() == [30, 90, 200]


async def test_settle_times_out_when_the_clock_is_not_ignored():
    scr = FakeScreen(busy=0)
    _frame, settled = await checks.settle(scr.shoot, None, interval=0.001, frames=3, timeout=0.05)
    assert not settled


def test_region_changed():
    a, b = canvas(), rect(canvas(), [10, 10, 20, 20])
    assert imaging.region_changed(a, b, [0, 0, 50, 50])
    assert not imaging.region_changed(a, b, [100, 100, 200, 200])
    assert not imaging.region_changed(a, b, [0, 0, 50, 50], ignore=[[0, 0, 30, 30]])


def test_parse_bbox_maps_1000_units_to_viewport():
    assert parse_bbox('{"bbox_2d": [500, 500, 600, 550]}', 1280, 800) == [640, 400, 768, 440]
    assert parse_bbox('```json\n[{"bbox_2d": [0, 0, 1000, 1000], "label": "x"}]\n```', 100, 50) == [0, 0, 100, 50]
    assert parse_bbox("I can't find it", 1280, 800) is None
    assert parse_bbox('{"bbox_2d": [10, 10, 5, 5]}', 1000, 1000) == [5, 5, 10, 10]
    assert map_box([0, 0, 1200, 10], 1000, 1000) is None
    assert parse_describe('{"name": "Done button", "target": "Done button, bottom right"}') == {
        "name": "Done button", "target": "Done button, bottom right"}


def _jpeg(a):
    return imaging.to_array(imaging.encode_jpeg(a, quality=70))


def test_a_live_view_jpeg_looks_the_same_as_the_screenshot_it_came_from():
    a = canvas(800, 600)
    rect(a, [100, 200, 240, 244])
    for x in range(110, 230, 9):          # text-like edges, where JPEG noise is worst
        a[215:230, x:x + 4] = (255, 255, 255)
    assert not imaging.looks_different(_jpeg(a), a, imaging.box_around([170, 222], 48, 800, 600))


def test_a_change_at_the_click_is_seen_through_jpeg_noise():
    a = canvas(800, 600)
    rect(a, [100, 200, 240, 244])
    b = a.copy()
    rect(b, [60, 160, 320, 300], (170, 50, 50))          # a dialog opened over the button
    box = imaging.box_around([170, 222], 48, 800, 600)
    assert imaging.looks_different(_jpeg(a), b, box)
    c = a.copy()
    rect(c, [600, 20, 700, 40], (0, 0, 0))               # a change far away doesn't count
    assert not imaging.looks_different(_jpeg(a), c, box)
    assert imaging.looks_different(_jpeg(a), canvas(400, 300), box)   # another size: not the same page


# ---------------------------------------------------------------- another system (systems.py)
#
# Synthetic pages drawn with OpenCV's built-in Hershey font (no system fonts, so the same pixels
# everywhere). "Another system" is the same page with its text a pixel off, drawn without
# antialiasing or a touch wider; "a real change" is a missing button or other words.

import cv2  # noqa: E402

from breakpatch_engine import config  # noqa: E402

PRE = [128, 64, 192, 128]        # the 64 x 64 pre-check box around the button (at 160, 96)
CHECK = [90, 130, 300, 160]      # a checkpoint on the line of text under it


def page(label="Save changes", note="Project saved", dx=0, dy=0, aa=True, scale=0.5, button=True):
    a = canvas(400, 200, (250, 250, 250))
    rect(a, [0, 0, 400, 30], (40, 40, 60))
    line = cv2.LINE_AA if aa else cv2.LINE_8
    if button:
        cv2.rectangle(a, (100 + dx, 80 + dy), (220 + dx, 112 + dy), (60, 90, 220), -1)
        cv2.putText(a, label, (108 + dx, 101 + dy), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 1, line)
    cv2.putText(a, note, (100 + dx, 150 + dy), cv2.FONT_HERSHEY_SIMPLEX, scale + 0.1, (30, 30, 30), 1, line)
    return a


RECORDED = page()


def dist(now, box, relaxed):
    return imaging.region_distance(now, box, imaging.region_hash(RECORDED, box), relaxed=relaxed)


def passes(now, box, tolerance, relaxed):
    return dist(now, box, relaxed) <= config.check_tolerance(tolerance, relaxed)


def test_relaxed_checks_allow_text_a_pixel_off():
    for moved in (page(dx=1), page(dy=1), page(dx=1, dy=1), page(dx=-1, dy=1)):
        assert passes(moved, PRE, config.PRE_TOLERANCE, relaxed=True)
        assert passes(moved, CHECK, config.CHECKPOINT_TOLERANCE, relaxed=True)
    # Strict, the pre-check fails when the button is a pixel to the right.
    assert not passes(page(dx=1), PRE, config.PRE_TOLERANCE, relaxed=False)


def test_relaxed_checks_allow_other_antialiasing_and_slightly_wider_text():
    for other in (page(aa=False), page(aa=False, dx=1), page(scale=0.52)):
        assert passes(other, PRE, config.PRE_TOLERANCE, relaxed=True)
        assert passes(other, CHECK, config.CHECKPOINT_TOLERANCE, relaxed=True)
        assert passes(other, PRE, config.POST_TOLERANCE, relaxed=True)


def test_relaxed_checks_still_catch_real_changes():
    assert not passes(page(button=False), PRE, config.PRE_TOLERANCE, relaxed=True)         # the button is gone
    assert not passes(page(label="Error"), PRE, config.PRE_TOLERANCE, relaxed=True)         # other words on it
    assert not passes(page(label="Delete all"), PRE, config.POST_TOLERANCE, relaxed=True)
    assert not passes(page(note="Save failed"), CHECK, config.CHECKPOINT_TOLERANCE, relaxed=True)
    assert not passes(page(note="Project not saved"), CHECK, config.CHECKPOINT_TOLERANCE, relaxed=True)
    # A real move of a few pixels is still a move.
    assert not passes(page(dx=3, dy=3), PRE, config.PRE_TOLERANCE, relaxed=True)


def test_relaxed_distance_is_never_more_than_the_exact_one():
    for now in (page(), page(dx=1), page(button=False), page(note="Save failed")):
        for box in (PRE, CHECK):
            assert dist(now, box, True) <= dist(now, box, False)
    assert dist(page(), PRE, True) == 0
    assert config.check_tolerance(6, False) == 6 and config.check_tolerance(6, True) == 6 + config.RELAXED_EXTRA


def test_relaxed_distance_keeps_ignore_zones_in_place():
    a, b = RECORDED.copy(), page(dx=1)
    rect(b, [102, 82, 130, 110], (255, 0, 0))                # a clock drawn over the button
    zone = [[100, 80, 132, 112]]
    want = imaging.region_hash(a, PRE, zone)
    assert imaging.region_distance(b, PRE, want, zone, relaxed=True) <= config.check_tolerance(config.PRE_TOLERANCE, True)
