"""Generate a local mock of the PDF produced by the Apps Script workflow."""

from pathlib import Path

from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth


ROOT = Path(__file__).resolve().parents[1]
ARTWORK = ROOT / "LAST TEMPLATE.png"
OUTPUT = ROOT / "output" / "pdf" / "gravity-foundation-pass-preview.pdf"

ARTWORK_WIDTH = 1024
ARTWORK_HEIGHT = 1536
PAGE_WIDTH = 5.33 * 72
PAGE_HEIGHT = 8 * 72


def add_field(pdf, value, x_px, line_y_px, size, width_px, color, scale, offset_x, offset_y, centered=False):
    """Approximate Slides typography using the same artwork line anchors."""
    x = offset_x + x_px * scale
    font = "Helvetica-BoldOblique" if centered else "Helvetica-Bold"
    width = width_px * scale
    font_size = min(size, size * width * 0.90 / max(1, stringWidth(str(value), font, size)))
    # Leave room for descenders above the artwork line.
    baseline = PAGE_HEIGHT - offset_y - line_y_px * scale + 2 + font_size * 0.2
    pdf.setFillColor(color)
    pdf.setFont(font, font_size)
    if centered:
        pdf.drawCentredString(x + width / 2, baseline, str(value))
    else:
        pdf.drawString(x, baseline, str(value))


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    scale = min(PAGE_WIDTH / ARTWORK_WIDTH, PAGE_HEIGHT / ARTWORK_HEIGHT)
    draw_width = ARTWORK_WIDTH * scale
    draw_height = ARTWORK_HEIGHT * scale
    offset_x = (PAGE_WIDTH - draw_width) / 2
    offset_y = (PAGE_HEIGHT - draw_height) / 2

    pdf = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_WIDTH, PAGE_HEIGHT))
    for name in ["Aryan Singh", "Dakshayani Venkataraman Subramaniam"]:
        pdf.drawImage(str(ARTWORK), offset_x, offset_y,
                      width=draw_width, height=draw_height, mask="auto")
        add_field(pdf, name, 326, 682, 12, 518, "#171717", scale, offset_x, offset_y)
        add_field(pdf, "4", 326, 862, 12, 518, "#171717", scale, offset_x, offset_y)
        add_field(pdf, "GRV-2026-PREVIEW", 448, 1002, 13, 356, "#9f1118", scale, offset_x, offset_y)
        add_field(pdf, name, 449, 1137, 11.5, 268, "#a71018", scale, offset_x, offset_y, True)
        pdf.showPage()
    pdf.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
