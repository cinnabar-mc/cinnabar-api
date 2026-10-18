"""Check that named emote exports and packaged clips remain reproducible."""
import hashlib
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def check_emotes(catalog):
    """Regenerate each authored emote and compare its bytes with the catalog and deployment copy."""
    spec = importlib.util.spec_from_file_location('emote_export', Path(__file__).with_name('export.py'))
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)
    used = set()
    for item in catalog.get('emotes', []):
        name = item['id'].split(':', 1)[1]
        path = ROOT / 'art/emotes' / f'{name}.clip.json'
        data = path.read_bytes()
        asset = item['clip']
        assert len(data) == asset['bytes']
        assert hashlib.sha256(data).hexdigest() == asset['sha256']
        assert data == (ROOT / 'assets/cosmetics' / asset['sha256']).read_bytes()
        assert asset['url'] == f"/v1/cosmetics/assets/{asset['sha256']}"
        assert data == exporter.sample(), f'{name}: stale sampled export'
        used.add(path.name)
    assert used == {path.name for path in (ROOT / 'art/emotes').glob('*.clip.json')}
