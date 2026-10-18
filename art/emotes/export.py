"""Sample Rust choreography and publish reproducible hash-addressed catalog clips."""
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ART = Path(__file__).resolve().parent


def sample():
    """Compile the original curve sampler against the schema's canonical rig and return its clip."""
    rig = json.loads((ROOT / 'schema/v1.json').read_text())['$defs']['EmoteClip']['x-rig']
    with tempfile.TemporaryDirectory(prefix='emote-export-') as temp:
        temp = Path(temp)
        shutil.copytree(ART, temp, dirs_exist_ok=True)
        records = []
        for joint in rig:
            parent = next((i for i, item in enumerate(rig) if item['joint'] == joint['parent']), None)
            pivot = ','.join(f'{value:.8f}' for value in joint['pivot'])
            records.append(f'("{joint["joint"]}",{f"Some({parent})" if parent is not None else "None"},[{pivot}])')
        (temp / 'rig.rs').write_text('const RIG: &[(&str, Option<usize>, [f32;3])] = &[\n' + ',\n'.join(records) + '\n];\nconst REFERENCE_HEIGHT: f32 = ' + str(next(joint['pivot'][1] for joint in rig if joint['joint'] == 'leftleg')) + '.0;\n')
        subprocess.run(['rustc', '--edition=2024', '-O', str(temp / 'sample.rs'), '-o', str(temp / 'sample')], check=True)
        return subprocess.check_output([str(temp / 'sample')])


def export():
    """Replace the named export and update its single catalog descriptor and packaged digest."""
    data = sample()
    (ART / 'breakdance.clip.json').write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    catalog_path = ROOT / 'src/catalog.json'
    catalog = json.loads(catalog_path.read_text())
    previous = next((item for item in catalog.get('emotes', []) if item['id'] == 'cinnabar:breakdance'), None)
    if previous and previous['clip']['sha256'] != digest:
        (ROOT / 'assets/cosmetics' / previous['clip']['sha256']).unlink(missing_ok=True)
    item = {'id': 'cinnabar:breakdance', 'display_name': 'Breakdance', 'free': True,
            'clip': {'url': f'/v1/cosmetics/assets/{digest}', 'sha256': digest, 'bytes': len(data)},
            'license': catalog['items'][0]['license']}
    catalog['emotes'] = [entry for entry in catalog.get('emotes', []) if entry['id'] != item['id']] + [item]
    catalog['version'] += 1 if previous != item else 0
    catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
    (ROOT / 'assets/cosmetics' / digest).write_bytes(data)


if __name__ == '__main__':
    export()
