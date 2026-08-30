#!/usr/bin/env python3
"""Render the canonical Markdown security review as a readable PDF."""

from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    ListFlowable,
    ListItem,
    LongTable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    TableStyle,
)


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "report-source.md"
OUTPUT = ROOT / "Terminus_Agent_Harness_Security_Review.pdf"
INK = colors.HexColor("#17212B")
MUTED = colors.HexColor("#596977")
TEAL = colors.HexColor("#087E78")
PALE = colors.HexColor("#EAF4F2")
GRID = colors.HexColor("#CDD9D7")


def register_fonts() -> tuple[str, str, str]:
    candidates = [
        ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/SFNSMono.ttf"),
        ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Menlo.ttc"),
    ]
    for sans, mono in candidates:
        if Path(sans).is_file() and Path(mono).is_file():
            try:
                pdfmetrics.registerFont(TTFont("TerminusSans", sans))
                pdfmetrics.registerFont(TTFont("TerminusMono", mono))
                return "TerminusSans", "TerminusSans", "TerminusMono"
            except Exception:
                continue
    return "Helvetica", "Helvetica-Bold", "Courier"


SANS, BOLD, MONO = register_fonts()


def inline(markdown: str) -> str:
    text = html.escape(markdown.strip())
    text = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda match: f'<link href="{match.group(2)}" color="#087E78">{match.group(1)}</link>',
        text,
    )
    text = re.sub(r"(?<!`)\*\*([^*]+)\*\*(?!`)", r"<b>\1</b>", text)
    text = re.sub(r"`([^`]+)`", lambda match: f'<font name="{MONO}">{match.group(1)}</font>', text)
    return text


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title", parent=base["Title"], fontName=BOLD, fontSize=27, leading=31,
            textColor=INK, alignment=TA_LEFT, spaceAfter=6,
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName=BOLD, fontSize=16, leading=19,
            textColor=TEAL, spaceBefore=14, spaceAfter=7, keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "H3", parent=base["Heading3"], fontName=BOLD, fontSize=11.5, leading=14,
            textColor=INK, spaceBefore=10, spaceAfter=5, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["BodyText"], fontName=SANS, fontSize=8.8, leading=12.2,
            textColor=INK, spaceAfter=6,
        ),
        "meta": ParagraphStyle(
            "Meta", parent=base["BodyText"], fontName=SANS, fontSize=8.5, leading=12,
            textColor=MUTED, spaceAfter=2,
        ),
        "quote": ParagraphStyle(
            "Quote", parent=base["BodyText"], fontName=SANS, fontSize=9, leading=12.5,
            leftIndent=10, borderColor=TEAL, borderWidth=2, borderPadding=7,
            backColor=PALE, textColor=INK, spaceBefore=4, spaceAfter=8,
        ),
        "table_header": ParagraphStyle(
            "TableHeader", parent=base["BodyText"], fontName=BOLD, fontSize=6.5, leading=8,
            textColor=colors.white, alignment=TA_LEFT,
        ),
        "table": ParagraphStyle(
            "Table", parent=base["BodyText"], fontName=SANS, fontSize=6.3, leading=8.1,
            textColor=INK,
        ),
    }


STYLES = styles()


def parse_table(lines: list[str], start: int) -> tuple[LongTable, int]:
    raw: list[list[str]] = []
    index = start
    while index < len(lines) and lines[index].lstrip().startswith("|"):
        cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
        if not all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            raw.append(cells)
        index += 1
    columns = max(len(row) for row in raw)
    page_width = landscape(A4)[0] - 28 * mm
    if columns == 5:
        widths = [23 * mm, 33 * mm, 45 * mm, 52 * mm, page_width - 153 * mm]
    elif columns == 2:
        widths = [62 * mm, page_width - 62 * mm]
    else:
        widths = [page_width / columns] * columns
    data = []
    for row_index, row in enumerate(raw):
        style = STYLES["table_header"] if row_index == 0 else STYLES["table"]
        data.append([Paragraph(inline(cell), style) for cell in row + [""] * (columns - len(row))])
    table = LongTable(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TEAL),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, GRID),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F6F9F8")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table, index


def build_story(markdown: str) -> list[object]:
    lines = markdown.splitlines()
    story: list[object] = []
    paragraph: list[str] = []
    first_heading = True

    def flush_paragraph() -> None:
        if paragraph:
            story.append(Paragraph(inline(" ".join(paragraph)), STYLES["body"]))
            paragraph.clear()

    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        if not line:
            flush_paragraph()
            index += 1
            continue
        if line.startswith("|"):
            flush_paragraph()
            table, index = parse_table(lines, index)
            story.extend([Spacer(1, 4), table, Spacer(1, 7)])
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            flush_paragraph()
            level = len(heading.group(1))
            title = heading.group(2)
            if level == 1 and first_heading:
                story.append(Spacer(1, 8 * mm))
                story.append(Paragraph(inline(title), STYLES["title"]))
                story.append(Spacer(1, 2 * mm))
                first_heading = False
            elif level == 2:
                if title in {"Implemented change", "Remaining work and recommendations", "Source ledger"}:
                    story.append(PageBreak())
                story.append(Paragraph(inline(title), STYLES["h2"]))
            else:
                story.append(Paragraph(inline(title), STYLES["h3"]))
            index += 1
            continue
        if line.startswith("**") and line.endswith("  "):
            flush_paragraph()
            story.append(Paragraph(inline(line.rstrip()), STYLES["meta"]))
            index += 1
            continue
        if line.startswith("> "):
            flush_paragraph()
            story.append(Paragraph(inline(line[2:]), STYLES["quote"]))
            index += 1
            continue
        list_match = re.match(r"^(?:[-*]|\d+\.)\s+", line)
        if list_match:
            flush_paragraph()
            items: list[ListItem] = []
            ordered = bool(re.match(r"^\d+\.\s+", line))
            item_pattern = r"^\d+\.\s+" if ordered else r"^[-*]\s+"
            while index < len(lines) and re.match(item_pattern, lines[index]):
                content = re.sub(item_pattern, "", lines[index]).strip()
                index += 1
                continuation: list[str] = []
                while index < len(lines) and lines[index].startswith("  "):
                    continuation.append(lines[index].strip())
                    index += 1
                if continuation:
                    content = " ".join([content, *continuation])
                items.append(ListItem(Paragraph(inline(content), STYLES["body"]), leftIndent=9))
            story.append(ListFlowable(
                items,
                bulletType="1" if ordered else "bullet",
                start="1" if ordered else None,
                leftIndent=14,
                bulletFontName=SANS,
            ))
            story.append(Spacer(1, 3))
            continue
        paragraph.append(line.strip())
        index += 1
    flush_paragraph()
    return story


def decorate(canvas, document) -> None:  # type: ignore[no-untyped-def]
    canvas.saveState()
    width, height = landscape(A4)
    canvas.setFillColor(TEAL)
    canvas.rect(0, height - 7 * mm, width, 7 * mm, stroke=0, fill=1)
    canvas.setFont(SANS, 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(14 * mm, 8 * mm, "TERMINUS  /  AGENT-HARNESS SECURITY REVIEW")
    canvas.drawRightString(width - 14 * mm, 8 * mm, f"{document.page}")
    canvas.restoreState()


def main() -> None:
    document = SimpleDocTemplate(
        str(OUTPUT), pagesize=landscape(A4),
        leftMargin=14 * mm, rightMargin=14 * mm, topMargin=13 * mm, bottomMargin=14 * mm,
        title="Terminus Agent-Harness Security Review",
        author="Terminus security review",
        subject="Security architecture and harness comparison",
    )
    document.build(build_story(SOURCE.read_text(encoding="utf-8")), onFirstPage=decorate, onLaterPages=decorate)


if __name__ == "__main__":
    main()
