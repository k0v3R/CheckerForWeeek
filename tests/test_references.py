"""Тесты ссылок между файлами расширения и бинарных ассетов (PNG/WAV)."""
import os
import re
import struct
import unittest

from common import EXT, read, read_bytes

# строки-литералы с путями в JS/HTML (относительные, с расширением файла)
PATH_RE = re.compile(r'''['"]([\w./-]+\.(?:html|js|css|png|wav|svg))['"]''')
HTML_ATTR_RE = re.compile(r'''(?:href|src)="([^"]+\.(?:css|js))"''')


def js_paths(filename):
    text = read(os.path.join(EXT, filename))
    return set(PATH_RE.findall(text))


def html_paths(relpath):
    text = read(os.path.join(EXT, relpath))
    return set(HTML_ATTR_RE.findall(text))


class TestCrossReferences(unittest.TestCase):
    """Каждый путь, упомянутый в коде, должен существовать внутри extension/.

    Важно: пути в JS (chrome.runtime.getURL и URL offscreen-документа)
    резолвятся от КОРНЯ расширения; href/src в HTML — от папки самого HTML.
    """

    def assert_all_exist(self, relpath, paths, base_dir):
        for ref in sorted(paths):
            self.assertFalse(ref.startswith('/') or '..' in ref,
                             f'{relpath}: путь должен быть относительным — {ref}')
            full = os.path.join(base_dir, ref)
            self.assertTrue(os.path.isfile(full), f'{relpath}: не найден {ref}')

    def test_background_js_paths(self):
        # background.js ссылается на offscreen-документ, звук и иконку тостов
        paths = js_paths('background.js')
        self.assertIn('offscreen/offscreen.html', paths)
        self.assertIn('icons/icon128.png', paths)
        self.assert_all_exist('background.js', paths, EXT)

    def test_offscreen_paths(self):
        paths = js_paths(os.path.join('offscreen', 'offscreen.js'))
        self.assertIn('sounds/notification.wav', paths)
        self.assert_all_exist(os.path.join('offscreen', 'offscreen.js'), paths, EXT)

    def test_popup_html_paths(self):
        rel = os.path.join('popup', 'popup.html')
        paths = html_paths(rel)
        self.assertEqual(paths, {'popup.css', 'popup.js'})
        self.assert_all_exist(rel, paths, os.path.join(EXT, 'popup'))

    def test_offscreen_html_paths(self):
        rel = os.path.join('offscreen', 'offscreen.html')
        paths = html_paths(rel)
        self.assertEqual(paths, {'offscreen.js'})
        self.assert_all_exist(rel, paths, os.path.join(EXT, 'offscreen'))


def png_size(path):
    data = read_bytes(path)
    self_sig = data[:8] == b'\x89PNG\r\n\x1a\n'
    if not self_sig or data[12:16] != b'IHDR':
        raise AssertionError(f'{path}: не PNG или нет IHDR')
    width, height = struct.unpack('>II', data[16:24])
    return width, height


class TestBinaryAssets(unittest.TestCase):
    def test_icons_are_valid_png_of_exact_size(self):
        for size in (16, 32, 48, 128):
            path = os.path.join(EXT, 'icons', f'icon{size}.png')
            w, h = png_size(path)
            self.assertEqual((w, h), (size, size), f'icon{size}.png: {w}x{h}')

    def test_no_weeek_brand_assets_in_popup(self):
        # иконки интерфейса — на базе Feather Icons (MIT), включая кнопку
        # настроек («sliders»); иконка приложения и звук — собственные
        self.assertFalse(os.path.isfile(os.path.join(EXT, 'icons', 'logo.svg')),
                         'icons/logo.svg должен быть удалён')
        html = read(os.path.join(EXT, 'popup', 'popup.html'))
        for banned in ('#016BFF', 'header__logo', 'state__logo',
                       'шестерёнка с сайта weeek', 'opacity="0.39"'):
            self.assertNotIn(banned, html, f'popup.html: остаток брендового SVG — {banned}')
        self.assertIn('x1="9" y1="8" x2="15" y2="8"', html,
                      'в попапе нет иконки настроек «sliders» (Feather)')

    def test_notification_sound_is_wav(self):
        data = read_bytes(os.path.join(EXT, 'sounds', 'notification.wav'))
        self.assertGreater(len(data), 1000, 'notification.wav подозрительно мал')
        self.assertEqual(data[:4], b'RIFF', 'notification.wav: нет RIFF-заголовка')
        self.assertEqual(data[8:12], b'WAVE', 'notification.wav: нет WAVE-маркера')


if __name__ == '__main__':
    unittest.main()
