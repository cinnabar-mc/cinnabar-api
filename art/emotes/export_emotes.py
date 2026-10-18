"""Check that named emote exports and packaged clips remain reproducible."""
import hashlib
import importlib.util
import json
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
        assert data == exporter.sample(name), f'{name}: stale sampled export'
        metadata = json.loads(path.with_name(f'{name}.emote.json').read_text())
        assert all(item[key] == metadata[key] for key in ('id', 'display_name', 'free'))
        clip = json.loads(data)
        assert clip['duration'] == metadata['duration'] and clip['loop'] == metadata['loop']
        used.add(name)
    assert used == {path.name.removesuffix('.clip.json') for path in (ROOT / 'art/emotes').glob('*.clip.json')}
    assert used == {path.name.removesuffix('.emote.json') for path in (ROOT / 'art/emotes').glob('*.emote.json')}
