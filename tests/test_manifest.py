"""Тесты manifest.json: структура MV3, поля, ссылки на файлы."""
import json
import os
import unittest

from common import EXT, read_bytes


def load_manifest():
    raw = read_bytes(os.path.join(EXT, 'manifest.json'))
    # BOM запрещён: Edge его терпит, но лучше держать файл чистым
    assert not raw.startswith(b'\xef\xbb\xbf'), 'manifest.json начинается с BOM'
    return json.loads(raw.decode('utf-8'))


class TestManifest(unittest.TestCase):
    def setUp(self):
        self.m = load_manifest()

    def test_valid_json_mv3(self):
        self.assertEqual(self.m['manifest_version'], 3)

    def test_required_fields(self):
        for field in ('name', 'version', 'description', 'action', 'background',
                      'permissions', 'host_permissions', 'icons'):
            self.assertIn(field, self.m, f'нет обязательного поля {field}')

    def test_version_matches_current_release(self):
        self.assertEqual(self.m['version'], '1.0.0')

    def test_name(self):
        # имя расширения — «Checker for Weeek»
        self.assertEqual(self.m['name'], 'Checker for Weeek')
        self.assertEqual(self.m['action']['default_title'], 'Checker for Weeek')

    def test_description_brand_casing(self):
        # в description бренд — «Weeek» с заглавной; домены остаются строчными
        self.assertIn('Weeek', self.m['description'])
        self.assertNotIn('weeek', self.m['description'].replace('app.weeek.net', ''))

    def test_permissions_exactly_expected(self):
        self.assertEqual(set(self.m['permissions']),
                         {'alarms', 'storage', 'cookies', 'offscreen', 'notifications'})

    def test_host_permissions(self):
        self.assertEqual(set(self.m['host_permissions']),
                         {'https://api.weeek.net/*', 'https://app.weeek.net/*'})

    def test_background_is_service_worker(self):
        self.assertEqual(self.m['background']['service_worker'], 'background.js')
        self.assertNotIn('page', self.m['background'])

    def test_no_web_accessible_resources_needed(self):
        # расширение не выстаивает ресурсы наружу (звук играет offscreen-документ)
        self.assertNotIn('web_accessible_resources', self.m)

    def test_referenced_files_exist(self):
        refs = []
        for size, path in self.m['icons'].items():
            refs.append((f'icon {size}', path))
        refs.append(('default_popup', self.m['action']['default_popup']))
        refs.append(('service_worker', self.m['background']['service_worker']))
        for size, path in self.m['action'].get('default_icon', {}).items():
            refs.append((f'action icon {size}', path))
        for label, rel in refs:
            self.assertFalse(os.path.isabs(rel), f'{label}: абсолютный путь {rel}')
            self.assertTrue(os.path.isfile(os.path.join(EXT, rel)),
                            f'{label}: файл не найден {rel}')

    def test_icon_sizes_cover_expected_set(self):
        self.assertEqual(set(self.m['icons'].keys()), {'16', '32', '48', '128'})


if __name__ == '__main__':
    unittest.main()
