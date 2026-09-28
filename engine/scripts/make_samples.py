"""Generate the bundled upload samples (spec §14): tiny, valid, non-sensitive files.

    .venv/bin/python scripts/make_samples.py

Writes src/breakpatch_engine/samples/sample.{docx,pdf,jpeg,mp4,xlsx,csv}. Output is deterministic
(fixed zip timestamps) so re-running doesn't churn git.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "src" / "breakpatch_engine" / "samples"
TEXT = "Breakpatch sample file. Safe to upload; contains no real data."
ZIP_DATE = (2024, 1, 1, 0, 0, 0)


def write_zip(path: Path, files: dict[str, str]) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items():
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, body)
    path.write_bytes(buf.getvalue())


def docx(path: Path) -> None:
    write_zip(path, {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/></Relationships>'),
        "word/document.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
            f'<w:p><w:r><w:t>{TEXT}</w:t></w:r></w:p></w:body></w:document>'),
    })


def xlsx(path: Path) -> None:
    rows = [("Name", "Quantity"), ("Sample item A", 3), ("Sample item B", 5)]

    def cell(ref: str, v) -> str:
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>'

    sheet_rows = "".join(
        f'<row r="{i}">' + "".join(cell(f"{'AB'[j]}{i}", v) for j, v in enumerate(r)) + "</row>"
        for i, r in enumerate(rows, start=1))
    write_zip(path, {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>'),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Sample" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/></Relationships>'),
        "xl/worksheets/sheet1.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<sheetData>{sheet_rows}</sheetData></worksheet>'),
    })


def pdf(path: Path) -> None:
    content = f"BT /F1 14 Tf 40 780 Td ({TEXT}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def picture(w: int = 160, h: int = 120, shift: int = 0) -> Image.Image:
    img = Image.new("RGB", (w, h), (238, 232, 226))
    d = ImageDraw.Draw(img)
    d.rectangle([10 + shift, 20, 70 + shift, 80], fill=(224, 113, 74))
    d.ellipse([90, 30, 140, 80], fill=(60, 120, 170))
    d.text((10, 95), "Breakpatch sample", fill=(40, 30, 25))
    return img


def jpeg(path: Path) -> None:
    picture().save(path, format="JPEG", quality=80)


def mp4(path: Path) -> None:
    w, h = 160, 120
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (w, h))
    if not writer.isOpened():
        raise SystemExit("OpenCV couldn't open an mp4 writer")
    for i in range(10):   # one second
        frame = cv2.cvtColor(np.asarray(picture(w, h, shift=i * 6)), cv2.COLOR_RGB2BGR)
        writer.write(frame)
    writer.release()


def csv(path: Path) -> None:
    path.write_text("name,quantity,note\nSample item A,3,Breakpatch sample\nSample item B,5,No real data\n")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for kind, fn in {"docx": docx, "pdf": pdf, "jpeg": jpeg, "mp4": mp4, "xlsx": xlsx, "csv": csv}.items():
        p = OUT / f"sample.{kind}"
        fn(p)
        print(f"{p.name}: {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
