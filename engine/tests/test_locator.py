"""The AI assistant's boxes and points map to and from viewport pixels exactly (finding: the box for
"the Next button" sat half a button too high). Qwen3-VL sees the screenshot resized, not padded or
cropped, to multiples of 32 within its pixel budget (1440 x 900 becomes 1248 x 768, a slightly
different scale in x and y), and answers in 0-1000 units of that image. Since the resize keeps the
whole picture, 0-1000 units map straight back to the screenshot's own size, in x and in y."""
import math

import pytest

from breakpatch_engine.locator import DESCRIBE_PROMPT, map_box, parse_bbox


def smart_resize(height, width, factor=32, min_pixels=56 * 56, max_pixels=14 * 14 * 4 * 1280):
    """mlx-vlm 0.7.3's Qwen3-VL image resize (models/qwen3_vl/processing_qwen3_vl.py)."""
    h_bar, w_bar = round(height / factor) * factor, round(width / factor) * factor
    if h_bar * w_bar > max_pixels:
        beta = math.sqrt((height * width) / max_pixels)
        h_bar = max(factor, math.floor(height / beta / factor) * factor)
        w_bar = max(factor, math.floor(width / beta / factor) * factor)
    elif h_bar * w_bar < min_pixels:
        beta = math.sqrt(min_pixels / (height * width))
        h_bar, w_bar = math.ceil(height * beta / factor) * factor, math.ceil(width * beta / factor) * factor
    return h_bar, w_bar


def model_reply(box, width, height):
    """What the model says for `box` (viewport px): it sees the resized image and answers in
    0-1000 units of it."""
    rh, rw = smart_resize(height, width)
    sx, sy = rw / width, rh / height
    x1, y1, x2, y2 = box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy
    units = [round(x1 / rw * 1000), round(y1 / rh * 1000), round(x2 / rw * 1000), round(y2 / rh * 1000)]
    return f'```json\n{{"bbox_2d": {units}}}\n```'


@pytest.mark.parametrize("width,height", [(1440, 900), (1280, 800), (390, 844), (1920, 1080), (800, 600)])
def test_a_box_round_trips_for_page_sizes_that_are_not_square(width, height):
    assert smart_resize(900, 1440) == (768, 1248)        # not the same scale in x and y
    # A full-width button under a field, like the owner's sign-in page.
    button = [round(width * 0.3), round(height * 0.55), round(width * 0.7), round(height * 0.55) + 48]
    got = parse_bbox(model_reply(button, width, height), width, height)
    # 0-1000 units are 1.44 px wide and 0.9 px high on 1440 x 900: that much rounding, no more.
    assert all(abs(g - b) <= math.ceil(max(width, height) / 1000) for g, b in zip(got, button)), (got, button)
    cy = (got[1] + got[3]) / 2
    assert abs(cy - (button[1] + button[3]) / 2) <= 1.5          # not half a button off


def test_a_point_round_trips_through_the_describe_prompt():
    width, height, at = 1440, 900, (720.0, 522.0)
    x, y = round(at[0] * 1000 / width), round(at[1] * 1000 / height)
    assert DESCRIBE_PROMPT.format(x=x, y=y).count(f"[{x}, {y}]") == 1
    assert abs(x * width / 1000 - at[0]) <= 1 and abs(y * height / 1000 - at[1]) <= 1


def test_boxes_outside_0_to_1000_are_refused_not_scaled():
    # Absolute pixel answers (the Qwen2.5-VL convention) would land somewhere else: refused.
    assert map_box([1100, 500, 1300, 548], 1440, 900) is None
    assert map_box([500, 500, 400, 548], 1440, 900) == [576, 450, 720, 493]
