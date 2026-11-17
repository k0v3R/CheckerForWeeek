"""Общие пути для тестов: корень репозитория и папка расширения."""
import os

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TESTS_DIR)
EXT = os.path.join(ROOT, 'extension')


def read(path, encoding='utf-8'):
    with open(path, encoding=encoding) as f:
        return f.read()


def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()
