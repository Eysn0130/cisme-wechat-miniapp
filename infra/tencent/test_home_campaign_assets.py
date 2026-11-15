import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('campaign_assets', Path(__file__).with_name('home-campaign-assets.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


def bundle(change=None, extra=None):
    rows, payloads = [], {}
    for index, key in enumerate(sorted(module.KEYS)):
        raw = b'\xff\xd8\xff' + bytes([index]) + b'\xff\xd9'
        digest = hashlib.sha256(raw).hexdigest(); name = digest + '.jpg'
        payloads[name] = raw
        rows.append({'key': key, 'sha256': digest, 'file': name, 'bytes': len(raw)})
    value = {'version': 1, 'kind': 'owner-approved-public-home-campaign', 'assets': rows}
    if change:
        change(value)
    payloads['manifest.json'] = json.dumps(value).encode()
    if extra:
        payloads.update(extra)
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:') as archive:
        for name, raw in payloads.items():
            info = tarfile.TarInfo(name); info.size = len(raw); archive.addfile(info, io.BytesIO(raw))
    return out.getvalue()


class CampaignAssetsTests(unittest.TestCase):
    def test_exact_four_content_addressed_photos(self):
        manifest, files, identity = module.decode_bundle(bundle())
        self.assertEqual(len(files), 5); self.assertEqual(len(identity), 16)
        self.assertEqual({r['key'] for r in manifest['assets']}, module.KEYS)

    def test_refuses_path_traversal_and_additional_objects(self):
        for name in ['../runtime.env', 'extra.jpg', 'private/member.jpg']:
            with self.assertRaises(RuntimeError): module.decode_bundle(bundle(extra={name: b'private'}))

    def test_refuses_bad_hash_or_missing_photo(self):
        with self.assertRaises(RuntimeError): module.decode_bundle(bundle(lambda m: m['assets'][0].update(sha256='0' * 64)))
        with self.assertRaises(RuntimeError): module.decode_bundle(bundle(lambda m: m['assets'].pop()))

    def test_routes_are_exact_public_get_only_and_environment_separated(self):
        assets = module.decode_bundle(bundle())[0]['assets']
        for profile, (root, _domain, _) in module.PROFILES.items():
            text = module.render_routes(profile, 'a' * 16, assets).decode()
            self.assertEqual(text.count('location = '), 4)
            self.assertIn(module.STATIC_ROOTS[profile] + '/home-campaign/', text)
            self.assertIn('limit_except GET { deny all; }', text)
            self.assertNotIn('add_header', text)  # Preserve inherited security headers.
            self.assertNotIn('autoindex', text); self.assertNotIn('proxy_pass', text)
        with self.assertRaises(RuntimeError): module.render_routes('retired-test', 'a' * 16, assets)

    def test_site_change_is_idempotent_and_preserves_other_configuration(self):
        source = 'server {\n server_name staging-api.cisme.cn;\n ssl_certificate /existing;\n add_header Strict-Transport-Security "max-age=31536000" always;\n location / { proxy_pass http://127.0.0.1:3101; }\n}\n'
        after = module.render_site(source, 'trial', 'a' * 16)
        self.assertEqual(module.render_site(after, 'trial', 'a' * 16), after)
        self.assertIn('Strict-Transport-Security "max-age=31536000" always;', after)
        self.assertIn('proxy_pass http://127.0.0.1:3101;', after)
        updated = module.render_site(after, 'trial', 'b' * 16)
        self.assertEqual(updated.count('CISME_HOME_CAMPAIGN_BEGIN'), 1)
        self.assertNotIn('/' + 'a' * 16 + '/', updated)
        with self.assertRaises(RuntimeError): module.render_site(source, 'release', 'a' * 16)


if __name__ == '__main__': unittest.main()
