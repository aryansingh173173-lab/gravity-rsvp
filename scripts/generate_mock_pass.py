"""Generate a local mock of the PDF produced by the Apps Script workflow."""

from pathlib import Path

from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
ARTWORK = ROOT / "gravity-annual-day-pass-template.png"
OUTPUT = ROOT / "output" / "pdf" / "gravity-pass-mock.pdf"

ARTWORK_WIDTH = 1024
ARTWORK_HEIGHT = 1535
PAGE_WIDTH = 5.33 * 72
PAGE_HEIGHT = 8 * 72


def add_field(pdf, value, x_px, y_px, font_px, color, scale, offset_x, offset_y):
    """Match the field positions and sizing used by Apps Script."""
    x = offset_x + x_px * scale
    y_from_top = offset_y + y_px * scale
    font_size = font_px * scale
    pdf.setFillColor(color)
    pdf.setFont("Helvetica-Bold", font_size)
    pdf.drawString(x, PAGE_HEIGHT - y_from_top - font_size, str(value))


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    scale = min(PAGE_WIDTH / ARTWORK_WIDTH, PAGE_HEIGHT / ARTWORK_HEIGHT)
    draw_width = ARTWORK_WIDTH * scale
    draw_height = ARTWORK_HEIGHT * scale
    offset_x = (PAGE_WIDTH - draw_width) / 2
    offset_y = (PAGE_HEIGHT - draw_height) / 2

    pdf = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_WIDTH, PAGE_HEIGHT))
    pdf.drawImage(
        str(ARTWORK),
        offset_x,
        offset_y,
        width=draw_width,
        height=draw_height,
        preserveAspectRatio=True,
        mask="auto",
    )
    add_field(pdf, "Aryan Singh", 330, 650, 26, "#171717", scale, offset_x, offset_y)
    add_field(pdf, "3", 330, 836, 26, "#171717", scale, offset_x, offset_y)
    add_field(pdf, "GRV-2026-MOCK", 466, 1028, 23, "#9f1118", scale, offset_x, offset_y)
    pdf.showPage()
    pdf.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
