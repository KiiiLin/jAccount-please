import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parents[1]
extension = root / "extension"
manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
name = manifest["name"]
archive = root / "dist" / f"{name}-v{manifest['version']}.zip"
archive.parent.mkdir(exist_ok=True)
files = {p.name: p for p in extension.iterdir() if p.is_file()}
files["README.md"] = root / "README.md"
files.update({p.relative_to(root).as_posix(): p for p in (root / "docs").glob("*.png")})
with ZipFile(archive, "w", ZIP_DEFLATED) as target:
    for relative, source in sorted(files.items()):
        target.write(source, f"{name}/{relative}")
with ZipFile(archive) as target:
    assert target.testzip() is None
print(archive)
