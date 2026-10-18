"""Check every catalog item's editable project and packaged assets without network access."""
import base64
import hashlib
import json
import sys
from pathlib import Path

from export import export, export_animations

ROOT = Path(__file__).resolve().parents[2]


def check():
    """Fail when an authored export, texture, catalog digest or packaged asset drifts."""
    catalog = json.loads((ROOT / 'src/catalog.json').read_text())
    projects = {}
    for path in Path(__file__).resolve().parent.glob('*.bbmodel'):
        project = json.loads(path.read_text())
        identifier = project['model_identifier']
        assert identifier not in projects, f'duplicate project geometry: {identifier}'
        projects[identifier] = (path, project)
    used = set()
    for item in catalog['items']:
        path, project = projects[item['geometry_id']]
        used.add(item['geometry_id'])
        for kind, asset in item['assets'].items():
            packed = (ROOT / 'assets/cosmetics' / asset['sha256']).read_bytes()
            assert len(packed) == asset['bytes'], f"{item['id']}: {kind} size"
            assert hashlib.sha256(packed).hexdigest() == asset['sha256'], f"{item['id']}: {kind} digest"
            suffix = {'geometry': '.geo.json', 'texture': '.png', 'animation': '.animation.json'}[kind]
            authored = path.with_suffix(suffix).read_bytes()
            assert authored == packed, f'{path.name}: {kind} differs from packaged asset'
        geometry = json.loads(path.with_suffix('.geo.json').read_text())
        assert export(project) == geometry, f'{path.name}: stale geometry export'
        source = project['textures'][0]['source']
        texture = (base64.b64decode(source.split(',', 1)[1], validate=True)
                   if source.startswith('data:image/png;base64,') else (path.parent / source).read_bytes())
        assert texture == path.with_suffix('.png').read_bytes(), f'{path.name}: stale texture export'
        if project.get('animations'):
            animation = json.loads(path.with_suffix('.animation.json').read_text())
            assert export_animations(project) == animation['animations'], f'{path.name}: stale animation export'
    assert used == projects.keys(), f'projects missing from catalog: {projects.keys() - used}'
    sys.path.insert(0, str(ROOT / 'art/emotes'))
    from export_emotes import check_emotes
    check_emotes(catalog)
    print(f'Checked {len(used)} cosmetic projects and their catalog assets')


if __name__ == '__main__':
    check()
