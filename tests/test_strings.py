"""Экстракция пользовательских строк и механические проверки текста
(баланс кавычек-«ёлочек», пробелы, регистр бренда Weeek).

Полный список строк пишется в tests/strings_report.txt — по нему делается
ручная орфографическая сверка.
"""
import html.parser
import json
import os
import re
import unittest

from common import EXT, TESTS_DIR, read

CYR = re.compile(r'[а-яёА-ЯЁ]')
NOT_TEXT = re.compile(r'^(?:https?://|/[\w./{}$-]*$|[\w./\\-]+\.(?:html|js|css|png|wav|svg)$)')

JS_STRING_RES = (
    re.compile(r"'((?:[^'\\\n]|\\.)*)'"),
    re.compile(r'"((?:[^"\\\n]|\\.)*)"'),
    re.compile(r'`([^`]*)`'),
)

REPORT_PATH = os.path.join(TESTS_DIR, 'strings_report.txt')


def extract_js_strings(relpath):
    text = read(os.path.join(EXT, relpath))
    found = []
    for rx in JS_STRING_RES:
        for m in rx.finditer(text):
            s = m.group(1)
            if CYR.search(s) and not NOT_TEXT.match(s):
                found.append(s.replace("\\'", "'").replace('\\"', '"'))
    return found


class _HTMLText(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.strings = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self._skip += 1
        for name, value in attrs:
            if name in ('title', 'aria-label', 'placeholder') and value and CYR.search(value):
                self.strings.append(value)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self._skip = max(0, self._skip - 1)

    def handle_data(self, data):
        if not self._skip:
            for chunk in data.split('\n'):
                if CYR.search(chunk):
                    self.strings.append(chunk.strip())


def extract_html_strings(relpath):
    parser = _HTMLText()
    parser.feed(read(os.path.join(EXT, relpath)))
    return [s for s in parser.strings if s and not NOT_TEXT.match(s)]


def collect_all():
    """Возвращает [(источник, строка), ...] — все видимые пользователю тексты."""
    items = []
    manifest = json.loads(read(os.path.join(EXT, 'manifest.json')))
    items.append(('extension/manifest.json [name]', manifest['name']))
    items.append(('extension/manifest.json [description]', manifest['description']))
    for rel in ('background.js', os.path.join('popup', 'popup.js')):
        for s in extract_js_strings(rel):
            items.append((f'extension/{rel}', s))
    for rel in (os.path.join('popup', 'popup.html'), os.path.join('offscreen', 'offscreen.html')):
        for s in extract_html_strings(rel):
            items.append((f'extension/{rel}', s))
    return items


class TestUserVisibleStrings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strings = collect_all()
        # отчёт для ручной орфографической сверки
        lines = ['# Пользовательские строки расширения (сгенерировано tests/test_strings.py)', '']
        src = None
        for source, s in cls.strings:
            if source != src:
                lines.append(f'## {source}')
                src = source
            lines.append(f'- {s!r}')
        with open(REPORT_PATH, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')

    def test_extraction_found_enough_strings(self):
        # здравая проверка самого экстрактора: в расширении заведомо > 40 строк
        self.assertGreaterEqual(len(self.strings), 40)

    def test_guiarre_balanced(self):
        for source, s in self.strings:
            self.assertEqual(s.count('«'), s.count('»'),
                             f'{source}: несбалансированные «» в {s!r}')

    def test_no_double_spaces(self):
        for source, s in self.strings:
            self.assertNotIn('  ', s, f'{source}: двойной пробел в {s!r}')

    def test_no_edge_whitespace(self):
        for source, s in self.strings:
            self.assertEqual(s, s.strip(), f'{source}: пробелы по краям в {s!r}')

    def test_brand_casing(self):
        # бренд в UI-строках — всегда «Weeek» с заглавной; строчное weeek
        # допустимо только внутри доменов (*.weeek.net); капс-бренд запрещён
        domain = re.compile(r'(?:app|api)\.weeek\.net')
        for source, s in self.strings:
            self.assertNotIn('WEEEK', s, f'{source}: капс-бренд в UI-строке: {s!r}')
            rest = domain.sub('', s)
            self.assertNotIn('weeek', rest,
                             f'{source}: строчный бренд вне домена — нужен «Weeek»: {s!r}')

    def test_no_dotdot_ellipsis(self):
        # в интерфейсе используется «…»/многоточие CSS, тройные точки не встречаются
        for source, s in self.strings:
            self.assertNotIn('..', s, f'{source}: «..» в {s!r}')

    def test_no_straight_double_quotes(self):
        # в RU-текстах — «ёлочки», прямые кавычки не используются
        for source, s in self.strings:
            self.assertNotIn('"', s, f'{source}: прямая кавычка в {s!r}')


if __name__ == '__main__':
    unittest.main()
