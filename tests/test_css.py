"""Тесты CSS попапа: конфликты атрибута hidden с авторскими display-правилами.

Браузерное UA-правило [hidden] { display: none } слабее ЛЮБОГО авторского
правила, объявляющего display на том же элементе. У .list есть
display: flex, поэтому els.list.hidden = true в showState() (popup.js)
список не прятал: после выхода из аккаунта первый клик по попапу показывал
экран «Войдите в» вместе с кэшем плиток прошлой сессии (исправлено
явным правилом .list[hidden]). DOM-стабы раннера popup CSS не
применяют — держим статическую проверку.
"""
import os
import re
import unittest

from common import EXT, read

# Элементы, которые popup.js прячет через el.hidden (showState и др.) и чьи
# классы объявлены в popup.css. Если класс в CSS получает display — нужно
# и правило class[hidden] { display: none }, как у .list.
HIDDEN_TOGGLED_CLASSES = ('list', 'state', 'btn', 'header__count')


class TestPopupCss(unittest.TestCase):
    def setUp(self):
        self.css = read(os.path.join(EXT, 'popup', 'popup.css'))
        # копия без комментариев: в «селектор» перед { попадает текст
        # комментария над правилом, ломающий точное сравнение
        self.css_nc = re.sub(r'/\*.*?\*/', '', self.css, flags=re.S)

    def display_declarations(self, selector_prefix):
        """Ищет `.{prefix}... { ... display: ... }` — блоки с display."""
        blocks = re.findall(r'([^{}]+)\{([^}]*)\}', self.css)
        out = []
        for selectors, body in blocks:
            if not re.search(r'display\s*:', body):
                continue
            for sel in selectors.split(','):
                sel = sel.strip()
                if sel.startswith(f'.{selector_prefix}'):
                    out.append(sel)
        return out

    def test_list_hidden_overrides_display_flex(self):
        # главный регресс: у .list есть display:flex → без явного правила
        # атрибут hidden список не прячет
        m = re.search(r'\.list\[hidden\]\s*\{([^}]*)\}', self.css)
        self.assertIsNotNone(m, 'нет правила .list[hidden] в popup.css')
        self.assertRegex(m.group(1), r'display\s*:\s*none')

    def test_hidden_toggled_classes_have_hidden_override_if_display_declared(self):
        # классы, которые JS прячет через hidden, не должны объявлять display
        # без парного правила class[hidden]
        for cls in HIDDEN_TOGGLED_CLASSES:
            for sel in self.display_declarations(cls):
                if f'[{cls}]' in sel or 'hidden' in sel:
                    continue  # само переопределяющее правило — ок
                override = re.search(
                    rf'\.{re.escape(cls)}\[hidden\][^{{}}]*\{{[^}}]*display\s*:\s*none',
                    self.css,
                )
                # base-селектор без модификаторов (state, btn) может объявлять
                # display, только если у него есть парное [hidden]-правило
                base_only = re.fullmatch(rf'\.{re.escape(cls)}', sel)
                if base_only:
                    self.assertIsNotNone(
                        override,
                        f'.{cls} объявляет display, но нет правила .{cls}[hidden] '
                        f'(атрибут hidden работать не будет)',
                    )

    def dark_media_bodies(self):
        """Тела @media (prefers-color-scheme: dark) — с учётом вложенных скобок."""
        bodies = []
        for m in re.finditer(r'@media \(prefers-color-scheme: dark\)\s*\{', self.css_nc):
            depth = 1
            i = m.end()
            while depth and i < len(self.css_nc):
                if self.css_nc[i] == '{':
                    depth += 1
                elif self.css_nc[i] == '}':
                    depth -= 1
                i += 1
            bodies.append(self.css_nc[m.end():i - 1])
        return bodies

    def test_dark_theme_has_explicit_dark_override(self):
        # настройка «Тёмная»: popup.js ставит <html data-theme="dark"> —
        # в CSS обязано быть правило с теми же токенами, что и в медиазапросе
        m = re.search(r':root\[data-theme="dark"\]\s*\{([^}]*)\}', self.css)
        self.assertIsNotNone(m, 'нет правила :root[data-theme="dark"] в popup.css')
        self.assertIn('--bg', m.group(1), 'правило data-theme="dark" без токенов темы')
        self.assertIn('--icon-idle', m.group(1),
                      'в тёмном блоке нет --icon-idle (цвет иконок в покое)')

    def test_dark_media_selectors_guarded_against_explicit_light(self):
        # при явной «Светлой» на тёмной системе тёмные правила медиазапроса
        # не должны применяться: каждый селектор внутри тёмного медиаблока
        # обязан быть ограничен :not([data-theme="light"])
        bodies = self.dark_media_bodies()
        self.assertTrue(bodies, 'нет тёмных медиаблоков — сломался системный режим')
        for body in bodies:
            for sel in re.findall(r'([^{}]+)\{', body):
                sel = sel.strip()
                if not sel:  # мусор до первой { (не бывает) — пропустить
                    continue
                self.assertIn(
                    ':not([data-theme="light"])',
                    sel,
                    f'тёмный медиаселектор без гарда явной светлой: {sel!r}',
                )

    def test_dark_theme_overrides_variables_only(self):
        # РЕГРЕСС шестерёнки: тёмные правила с селектором вида
        # :root:not([data-theme="light"]) .header__gear svg получают
        # специфичность (0,3,1) и перебивают hover-правило (0,2,1) —
        # иконка перестаёт перекрашиваться при наведении. Тёмная тема
        # имеет право перекрашивать ТОЛЬКО корневые блоки токенов; всё
        # элементное — через переменные.
        for body in self.dark_media_bodies():
            for sel in re.findall(r'([^{}]+)\{', body):
                sel = ' '.join(sel.split())
                self.assertEqual(
                    sel,
                    ':root:not([data-theme="light"])',
                    f'в тёмном медиаблоке допустим только корень токенов, найдено: {sel!r}',
                )
        for sel in re.findall(r'([^{}]+)\{', self.css_nc):
            if '[data-theme="dark"]' in sel:
                self.assertEqual(
                    ' '.join(sel.split()),
                    ':root[data-theme="dark"]',
                    f'элементное тёмное правило вне токенов запрещено: {sel!r}',
                )

    def test_dark_bg_differs_from_surface(self):
        # РЕГРЕСС: --bg и --surface в тёмной теме были одним #131416 — плитки
        # и шапка сливались с фоном. Как в светлой теме (#F8F8FB против
        # #FFFFFF), тёмный фон обязан отличаться от поверхностей (сейчас фон
        # светлее: #1A1B1D против #131416)
        def token(block, name):
            m = re.search(rf'{name}\s*:\s*([^;]+);', block)
            self.assertIsNotNone(m, f'нет {name} в блоке')
            return m.group(1).strip()

        media = self.dark_media_bodies()
        self.assertTrue(media)
        for label, block in (('медиаблок', media[0]),
                             ('data-theme="dark"', re.search(
                                 r':root\[data-theme="dark"\]\s*\{([^}]*)\}',
                                 self.css_nc).group(1))):
            bg = token(block, '--bg')
            surface = token(block, '--surface')
            self.assertNotEqual(
                bg.lower(), surface.lower(),
                f'{label}: фон сливается с поверхностью ({bg})',
            )

    def test_icon_idle_is_variable_and_hover_not_shadowed(self):
        # иконка настроек и точки «⋯» в покое красятся переменной --icon-idle,
        # их hover-правила существуют и потому выигрывают в любой теме
        gear = re.search(r'\.header__gear svg\s*\{([^}]*)\}', self.css)
        self.assertIsNotNone(gear, 'нет правила .header__gear svg')
        self.assertIn('color: var(--icon-idle)', gear.group(1))
        gear_hover = re.search(r'\.header__gear:hover svg\s*\{([^}]*)\}', self.css)
        self.assertIsNotNone(gear_hover, 'нет правила .header__gear:hover svg')
        self.assertIn('color: var(--icon-hover)', gear_hover.group(1),
                      'hover иконки настроек должен идти через --icon-hover')
        # токен hover: светлый — фирменный, оба тёмных блока — цвет шрифта
        self.assertEqual(self.css.count('--icon-hover:'), 3,
                         '--icon-hover должен быть в светлом корне и в обоих тёмных блоках')
        self.assertEqual(self.css.count('--icon-hover: var(--text-1)'), 2,
                         'в тёмных блоках hover = цвет шрифта')
        self.assertIn('--icon-hover: #6C78F4', self.css, 'в светлой теме hover фирменный')
        dots = re.search(r'\.tile__menu-btn\s*\{([^}]*)\}', self.css)
        self.assertIsNotNone(dots, 'нет правила .tile__menu-btn')
        self.assertIn('color: var(--icon-idle)', dots.group(1))
        dots_hover = re.search(r'\.tile__menu-btn:hover[^{]*\{([^}]*)\}', self.css)
        self.assertIsNotNone(dots_hover, 'нет hover-правила .tile__menu-btn')
        self.assertIn('var(--accent)', dots_hover.group(1))


if __name__ == '__main__':
    unittest.main()
