"""Сборка однофайловой версии для публикации: скрипты встраиваются в index.html, фото остаются файлами."""
import re, json, os, shutil
root = os.path.dirname(os.path.abspath(__file__))
html = open(os.path.join(root, 'index.html'), encoding='utf-8').read()
manifest_js = open(os.path.join(root, 'data/manifest.js'), encoding='utf-8').read()
ids = json.loads(re.search(r"DSF\.manifest\s*=\s*(\[[^\]]*\])", manifest_js).group(1).replace("'", '"'))
def inline(path):
    src = open(os.path.join(root, path), encoding='utf-8').read()
    assert '</script' not in src.lower(), path
    return f'<script>/* {path} */\n{src}\n</script>'
# порядок: манифест → хранилище → движок → расширения движка → датасеты → интерфейс
parts = [inline('data/manifest.js'), inline('assets/store.js'), inline('assets/engine.js'), inline('assets/engine-records.js'), inline('assets/engine-flow.js'), inline('assets/config.js')] + \
        [inline(f'data/projects/{i}.js') for i in ids] + [inline(f'data/flow/{i}.js') for i in ids if os.path.exists(os.path.join(root, f'data/flow/{i}.js'))] + [inline('assets/ui.js'), inline('assets/ui-work.js'), inline('assets/ui-flow.js'), inline('assets/admin.js')]
pat = r'<script src="data/manifest.js"></script>\s*<script src="assets/store.js"></script>\s*<script src="assets/engine.js"></script>\s*<script src="assets/engine-records.js"></script>\s*<script src="assets/engine-flow.js"></script>\s*<script src="assets/config.js"></script>\s*<script src="assets/ui.js"></script>\s*<script src="assets/ui-work.js"></script>\s*<script src="assets/ui-flow.js"></script>\s*<script src="assets/admin.js"></script>'
assert re.search(pat, html), 'script tags not found'
html = re.sub(pat, lambda m: '\n'.join(parts), html)
html = html.replace('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n', '')
out = os.path.join(root, 'dist'); shutil.rmtree(out, ignore_errors=True); os.makedirs(out + '/photos')
open(out + '/index.html', 'w', encoding='utf-8').write(html)
used = set(re.findall(r"(?:file|cover): '([^']+)'", ''.join(open(os.path.join(root, f'data/projects/{i}.js'), encoding='utf-8').read() for i in ids)))
for u in used: shutil.copy(os.path.join(root, 'photos', u + '.jpg'), out + '/photos/')
print('index.html', len(html), 'bytes; photos', len(used))
