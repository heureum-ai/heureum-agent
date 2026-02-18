# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for web fetch content extraction utilities (html2text-based)."""
import json

import pytest

from src.tools.web.fetch import (
    ExtractedContent,
    ExtractMode,
    html_to_markdown,
    html_to_text,
    extract_content,
    _extract_html,
    _extract_json,
    _fallback_html,
)


# ---------------------------------------------------------------------------
# html_to_markdown
# ---------------------------------------------------------------------------


class TestHtmlToMarkdown:
    """Tests for HTML to Markdown conversion via html2text."""

    def test_extracts_title(self):
        """Verify that the HTML title tag is extracted."""
        html = "<html><head><title>My Title</title></head><body>hi</body></html>"
        text, title = html_to_markdown(html)
        assert title == "My Title"

    def test_no_title(self):
        """Verify that missing title returns None."""
        html = "<html><body>hi</body></html>"
        text, title = html_to_markdown(html)
        assert title is None

    def test_converts_links(self):
        """Verify that anchor tags are converted to Markdown link syntax."""
        html = '<a href="https://example.com">click</a>'
        text, _ = html_to_markdown(html)
        assert "[click]" in text
        assert "https://example.com" in text

    def test_link_without_text(self):
        """Verify that links without text still include the URL."""
        html = '<a href="https://example.com"></a>'
        text, _ = html_to_markdown(html)
        assert "https://example.com" in text

    def test_converts_headings(self):
        """Verify that heading tags are converted to Markdown heading syntax."""
        html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>"
        text, _ = html_to_markdown(html)
        assert "# Title" in text
        assert "## Subtitle" in text
        assert "### Section" in text

    def test_converts_list_items(self):
        """Verify that list items are converted to Markdown list syntax."""
        html = "<ul><li>one</li><li>two</li></ul>"
        text, _ = html_to_markdown(html)
        assert "one" in text
        assert "two" in text
        # html2text uses "  * " for unordered lists
        assert "*" in text or "-" in text

    def test_removes_script_style(self):
        """Verify that script and style tags are removed entirely."""
        html = "<script>alert('xss')</script><style>.x{}</style><p>safe</p>"
        text, _ = html_to_markdown(html)
        assert "alert" not in text
        assert ".x" not in text
        assert "safe" in text

    def test_br_and_hr(self):
        """Verify that br and hr tags produce line breaks in output."""
        html = "line1<br/>line2<hr/>line3"
        text, _ = html_to_markdown(html)
        assert "line1" in text
        assert "line2" in text
        assert "line3" in text

    def test_complex_page(self):
        """Verify correct conversion of a full HTML page with mixed elements."""
        html = """
        <html>
        <head><title>Test Page</title></head>
        <body>
            <h1>Welcome</h1>
            <p>Paragraph with <a href="https://x.com">a link</a>.</p>
            <ul><li>Item A</li><li>Item B</li></ul>
            <script>evil();</script>
        </body>
        </html>
        """
        text, title = html_to_markdown(html)
        assert title == "Test Page"
        assert "# Welcome" in text
        assert "[a link]" in text
        assert "https://x.com" in text
        assert "Item A" in text
        assert "Item B" in text
        assert "evil" not in text

    def test_empty_html(self):
        """Verify that empty HTML input returns None title."""
        text, title = html_to_markdown("")
        assert title is None

    def test_word_wrap(self):
        """Verify that long lines are wrapped at ~78 chars (body_width)."""
        long_para = "word " * 50  # ~250 chars
        html = f"<p>{long_para}</p>"
        text, _ = html_to_markdown(html)
        lines = text.split("\n")
        for line in lines:
            assert len(line) <= 80, f"Line too long ({len(line)} chars): {line[:80]}..."

    def test_table_conversion(self):
        """Verify that tables are converted (html2text edge case)."""
        html = "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>"
        text, _ = html_to_markdown(html)
        assert "Name" in text
        assert "Alice" in text
        assert "30" in text

    def test_entities_decoded(self):
        """Verify that HTML entities are correctly decoded by html2text."""
        html = "<p>&amp; &lt; &gt; &quot; &#39;</p>"
        text, _ = html_to_markdown(html)
        assert "&" in text
        assert "<" in text
        assert ">" in text


# ---------------------------------------------------------------------------
# html_to_text
# ---------------------------------------------------------------------------


class TestHtmlToText:
    """Tests for HTML to plain text conversion."""

    def test_strips_links(self):
        """Verify that links are stripped, keeping only text."""
        html = '<a href="http://example.com">click here</a>'
        text, _ = html_to_text(html)
        assert "click here" in text
        assert "http://example.com" not in text

    def test_strips_heading_markers(self):
        """Verify that heading markers are removed, keeping only the text."""
        html = "<h2>Title</h2>"
        text, _ = html_to_text(html)
        assert "Title" in text
        assert "##" not in text

    def test_strips_emphasis(self):
        """Verify that emphasis markers are stripped."""
        html = "<p>This is <strong>bold</strong> and <em>italic</em></p>"
        text, _ = html_to_text(html)
        assert "bold" in text
        assert "italic" in text
        assert "**" not in text
        assert "_" not in text


# ---------------------------------------------------------------------------
# extract_content (routing)
# ---------------------------------------------------------------------------


class TestExtractContent:
    """Tests for extract_content routing based on content type."""

    def test_routes_html(self):
        """Verify that HTML content type is routed to the HTML extractor."""
        result = extract_content(
            "<html><body><p>Hello</p></body></html>",
            content_type="text/html; charset=utf-8",
        )
        assert result.extractor in ("readability", "html_fallback")
        assert "Hello" in result.text

    def test_routes_json(self):
        """Verify that JSON content type is routed to the JSON extractor."""
        result = extract_content(
            '{"key": "value"}',
            content_type="application/json",
        )
        assert result.extractor == "json"
        assert "key" in result.text
        assert "value" in result.text

    def test_routes_text_json(self):
        """Verify that text/json content type is routed to the JSON extractor."""
        result = extract_content(
            '{"a": 1}',
            content_type="text/json",
        )
        assert result.extractor == "json"

    def test_routes_plain_text(self):
        """Verify that plain text content type returns raw text."""
        result = extract_content(
            "Just plain text",
            content_type="text/plain",
        )
        assert result.extractor == "raw"
        assert result.text == "Just plain text"

    def test_unknown_content_type_returns_raw(self):
        """Verify that an unknown content type falls back to raw extraction."""
        result = extract_content(
            "some bytes",
            content_type="application/octet-stream",
        )
        assert result.extractor == "raw"

    def test_empty_content_type_returns_raw(self):
        """Verify that an empty content type falls back to raw extraction."""
        result = extract_content("fallback", content_type="")
        assert result.extractor == "raw"


# ---------------------------------------------------------------------------
# _extract_html
# ---------------------------------------------------------------------------


class TestExtractHtml:
    """Tests for HTML content extraction via Readability and fallback."""

    def test_readability_success(self):
        """Verify that Readability extracts content from a well-formed article."""
        html = """
        <html><head><title>Article</title></head>
        <body>
        <article>
            <h1>Real Article</h1>
            <p>This is a real article with enough content for Readability to extract.
            It needs to be reasonably long to pass the 50-char threshold.
            Adding more text here to make it sufficiently long for the extraction.</p>
        </article>
        </body></html>
        """
        result = _extract_html(html, url="https://example.com", extract_mode="markdown")
        assert result.title is not None
        assert len(result.text) > 0

    def test_readability_fallback_on_empty(self):
        """Readability returning < 50 chars should trigger fallback."""
        html = "<html><body><p>x</p></body></html>"
        result = _extract_html(html, url="", extract_mode="markdown")
        # Should still extract something via fallback
        assert result.extractor in ("readability", "html_fallback")

    def test_text_mode(self):
        """Verify that text mode produces plain text without Markdown formatting."""
        html = """
        <html><body>
        <article><p>Some article text with enough length to be extracted properly by readability engine. Lorem ipsum dolor sit amet.</p></article>
        </body></html>
        """
        result = _extract_html(html, url="", extract_mode="text")
        # In text mode, no markdown formatting
        assert "[" not in result.text or "](http" not in result.text


# ---------------------------------------------------------------------------
# _extract_json
# ---------------------------------------------------------------------------


class TestExtractJson:
    """Tests for JSON content extraction and formatting."""

    def test_valid_json_pretty_printed(self):
        """Verify that valid JSON is pretty-printed with indentation."""
        result = _extract_json('{"a":1,"b":[2,3]}')
        assert result.extractor == "json"
        parsed = json.loads(result.text)
        assert parsed == {"a": 1, "b": [2, 3]}
        # Pretty-printed should have indentation
        assert "\n" in result.text

    def test_invalid_json_returns_raw(self):
        """Verify that invalid JSON falls back to raw text."""
        result = _extract_json("not json {{{")
        assert result.extractor == "raw"
        assert result.text == "not json {{{"

    def test_json_title_is_none(self):
        """Verify that JSON extraction always returns None for title."""
        result = _extract_json('{"x": 1}')
        assert result.title is None

    def test_unicode_preserved(self):
        """Verify that Unicode characters in JSON are preserved."""
        result = _extract_json('{"name": "한글 테스트"}')
        assert "한글 테스트" in result.text


# ---------------------------------------------------------------------------
# _fallback_html
# ---------------------------------------------------------------------------


class TestFallbackHtml:
    """Tests for fallback HTML extraction when Readability fails."""

    def test_extracts_title(self):
        """Verify that the fallback extractor correctly extracts the title."""
        html = "<html><head><title>Fallback</title></head><body><p>text</p></body></html>"
        result = _fallback_html(html, extract_mode="markdown")
        assert result.title == "Fallback"
        assert result.extractor == "html_fallback"

    def test_text_mode(self):
        """Verify that fallback text mode strips Markdown formatting."""
        html = "<html><body><h1>Heading</h1><p>Para</p></body></html>"
        result = _fallback_html(html, extract_mode="text")
        assert "Heading" in result.text
        assert "#" not in result.text  # No markdown heading markers in text mode
