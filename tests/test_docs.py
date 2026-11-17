"""Консистентность документации с манифестом: версия, имя, permissions."""
import os
import re
import unittest

from common import ROOT, read
from test_manifest import load_manifest


class TestDocsConsistency(unittest.TestCase):
    def setUp(self):
        self.m = load_manifest()
        self.readme = read(os.path.join(ROOT, 'README.md'))
        self.docs = read(os.path.join(ROOT, 'docs', 'README.md'))
        self.handoff = read(os.path.join(ROOT, 'docs', 'HANDOFF.md'))

    def test_version_consistent_everywhere(self):
        version = self.m['version']
        self.assertIn(version, self.readme, f'README.md: нет версии {version}')
        self.assertIn(version, self.docs, f'docs/README.md: нет версии {version}')
        self.assertIn(version, self.handoff, f'HANDOFF.md: нет версии {version}')

    def test_extension_name_consistent(self):
        name = self.m['name']
        self.assertIn(name, self.docs, f'docs/README.md: нет имени «{name}»')
        self.assertIn(name, self.handoff, f'HANDOFF.md: нет имени «{name}»')

    def test_docs_list_all_permissions(self):
        for doc, label in ((self.docs, 'docs/README.md'), (self.handoff, 'HANDOFF.md')):
            for perm in self.m['permissions']:
                self.assertRegex(doc, rf'\b{perm}\b',
                                 f'{label}: не упомянуто право {perm}')

    def test_handoff_documents_all_api_endpoints(self):
        for endpoint in ('/user/profile/me', '/notifications?limit=15',
                         '/notifications/{id}/read'):
            self.assertIn(endpoint, self.handoff, f'HANDOFF.md: нет {endpoint}')

    def test_hard_invariant_documented(self):
        # главный инвариант: открытие попапа только GET, чтение — только по клику
        self.assertIn('GET-only', self.handoff)
        self.assertIn('ничего не помечает прочитанным', self.docs)


if __name__ == '__main__':
    unittest.main()
