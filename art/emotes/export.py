"""Sample Rust choreography and publish reproducible hash-addressed catalog clips."""
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ART = Path(__file__).resolve().parent


def sample(name):
    """Compile the original curve sampler against the schema's canonical rig and return its clip."""
    metadata = json.loads((ART / f'{name}.emote.json').read_text())
    rig = json.loads((ROOT / 'schema/v1.json').read_text())['$defs']['EmoteClip']['x-rig']
    with tempfile.TemporaryDirectory(prefix='emote-export-') as temp:
        temp = Path(temp)
        shutil.copytree(ART, temp, dirs_exist_ok=True)
        (temp / 'choreography.rs').write_text(
            f'mod {name}; use {name} as choreography;\n'
            f'const DURATION: f64 = {metadata["duration"]};\n'
            f'const LOOPING: bool = {str(metadata["loop"]).lower()};\n')
        records = []
        for joint in rig:
            parent = next((i for i, item in enumerate(rig) if item['joint'] == joint['parent']), None)
            pivot = ','.join(f'{value:.8f}' for value in joint['pivot'])
            records.append(f'("{joint["joint"]}",{f"Some({parent})" if parent is not None else "None"},[{pivot}])')
        (temp / 'rig.rs').write_text('const RIG: &[(&str, Option<usize>, [f32;3])] = &[\n' + ',\n'.join(records) + '\n];\nconst REFERENCE_HEIGHT: f32 = ' + str(next(joint['pivot'][1] for joint in rig if joint['joint'] == 'leftleg')) + '.0;\n')
        subprocess.run(['rustc', '--edition=2024', '-O', str(temp / 'sample.rs'), '-o', str(temp / 'sample')], check=True)
        return subprocess.check_output([str(temp / 'sample')])


def export():
    """Regenerate every authored clip and update its catalog descriptor and packaged digest."""
    catalog_path = ROOT / 'src/catalog.json'
    catalog = json.loads(catalog_path.read_text())
    for path in sorted(ART.glob('*.emote.json')):
        name = path.name.removesuffix('.emote.json')
        metadata = json.loads(path.read_text())
        data = sample(name)
        (ART / f'{name}.clip.json').write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        previous = next((item for item in catalog.get('emotes', []) if item['id'] == metadata['id']), None)
        if previous and previous['clip']['sha256'] != digest:
            (ROOT / 'assets/cosmetics' / previous['clip']['sha256']).unlink(missing_ok=True)
        item = {key: metadata[key] for key in ('id', 'display_name', 'free')}
        item['clip'] = {'url': f'/v1/cosmetics/assets/{digest}', 'sha256': digest, 'bytes': len(data)}
        item['license'] = catalog['items'][0]['license']
        entries = catalog.setdefault('emotes', [])
        index = next((i for i, entry in enumerate(entries) if entry['id'] == item['id']), len(entries))
        if index == len(entries):
            entries.append(item)
        else:
            entries[index] = item
        catalog['version'] += int(previous != item)
        (ROOT / 'assets/cosmetics' / digest).write_bytes(data)
    catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')


if __name__ == '__main__':
    export()
