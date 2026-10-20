"""Offline regression tests; only synthetic cookies and a stub keyring are used."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


class CookieImporterTests(unittest.TestCase):
    def test_encrypted_console_cookie(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Legacy Linux v11 AES-CBC, with the modern host SHA-256 prefix.
            import hashlib
            password = b'synthetic-keyring-password'
            key = hashlib.pbkdf2_hmac('sha1', password, b'saltysalt', 1, 16).hex()
            value = b'synthetic-console-session'
            payload = hashlib.sha256(b'opencode.ai').digest() + value
            encrypted = subprocess.run(['openssl', 'enc', '-aes-128-cbc', '-K', key,
                                        '-iv', '20' * 16], input=payload, capture_output=True, check=True).stdout
            keyring = root / 'secret-tool'
            keyring.write_text('#!/bin/sh\nprintf "label = Microsoft Edge Safe Storage\\nsecret = synthetic-keyring-password\\n"\n')
            keyring.chmod(0o755)
            database = root / 'Cookies'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
                db.execute('INSERT INTO cookies VALUES (?, ?, ?, ?)', ('opencode.ai', '__Host-console_session', '', b'v11' + encrypted))
            result = subprocess.run(['bash', str(Path(__file__).parent / 'scripts/codexbar-cookie-importer'),
                                     '--provider', 'opencodego', '--profile', str(database)],
                                    env=dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH']),
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)['cookie_header'], '__Host-console_session=' + value.decode())

    def test_opencode_console_cookie_domain_and_profile_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            keyring = root / 'secret-tool'
            keyring.write_text('#!/bin/sh\nexit 1\n')
            keyring.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'])
            database = root / 'Cookies'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
                db.executemany('INSERT INTO cookies VALUES (?, ?, ?, ?)', [
                    ('opencode.ai', '__Host-console_session', 'synthetic-session', b''),
                    ('evilopencode.ai', '__Host-console_session', 'wrong-domain', b''),
                    ('opencode.ai.evil.test', '__Host-console_session', 'wrong-suffix', b''),
                    ('chatgpt.com', '__Host-console_session', 'other-provider', b''),
                    ('opencode.ai', 'prefix__Host-console_session', 'wrong-name', b''),
                ])
            script = str(Path(__file__).parent / 'scripts/codexbar-cookie-importer')
            for provider in ('opencode', 'opencodego'):
                result = subprocess.run(['bash', script, '--provider', provider, '--profile', str(database)],
                                        env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout)['cookie_header'], '__Host-console_session=synthetic-session')
            with sqlite3.connect(database) as db:
                db.execute("DELETE FROM cookies WHERE host_key = 'opencode.ai' AND name = '__Host-console_session'")
            result = subprocess.run(['bash', script, '--provider', 'opencodego', '--profile', str(database)],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)['error'], 'SESSION_NOT_FOUND')


if __name__ == '__main__':
    unittest.main()
